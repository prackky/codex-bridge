import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { once } from 'node:events';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { CodexSession } from '../codex.mjs';
import { createBridge, parseRequest } from '../server.mjs';

const token = 'test-token-with-at-least-24-bytes';
const fakePath = fileURLToPath(new URL('./fake-codex.mjs', import.meta.url));
function factory(options = {}, auth = 'chatgpt') {
  return new CodexSession({ ...options, spawnProcess: (_bin, args, childOptions) => {
    assert.equal(args[0], 'app-server');
    assert.ok(args.includes('model_provider="openai"'));
    assert.ok(args.includes('features.shell_tool=false'));
    assert.ok(args.includes('features.code_mode_host=true'));
    assert.equal(childOptions.env.OPENAI_API_KEY, undefined);
    assert.equal(childOptions.env.BRIDGE_TOKEN, undefined);
    return spawn(process.execPath, [fakePath], { ...childOptions, env: { ...childOptions.env, FAKE_AUTH: auth } });
  } });
}
async function setup(t, options = {}) {
  const server = createBridge({ token, sessionFactory: factory, ...options });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.shutdown(); server.closeAllConnections(); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const request = (path, body, headers = {}) => fetch(url + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { server, request, url };
}

test('validates unsupported protocol instead of silently dropping fields', () => {
  for (const body of [null, [], { input: '' }, { input: 'x', tools: [{}] }, { input: 'x', previous_response_id: 'x' },
    { input: 'x', max_output_tokens: 10 }, { input: 'x', stream: 'true' }, { input: 'x', store: true },
    { input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'x' }] }] }]) {
    assert.throws(() => parseRequest(body), { status: 400 });
  }
  const request = parseRequest({ messages: [{ role: 'system', content: 'Be brief' },
    { role: 'user', content: 'Hi' }, { role: 'assistant', content: 'Hello' }, { role: 'user', content: 'Again' }] }, true);
  assert.equal(request.instructions, 'Be brief');
  assert.match(request.prompt, /conversation history/);
});


test('ignores private top-level Copilot metadata only on Chat Completions', () => {
  assert.doesNotThrow(() => parseRequest({ messages: [{ role: 'user', content: 'Hi' }], snippy: true, future_client_metadata: { version: 1 } }, true));
  assert.throws(() => parseRequest({ input: 'Hi', snippy: true }), { status: 400 });
});


test('accepts standard scalar generation controls as validated compatibility no-ops', () => {
  const controls = { temperature: 0, top_p: 0.95, frequency_penalty: 0, presence_penalty: 0, seed: 42,
    max_tokens: 4096, max_completion_tokens: 4096 };
  assert.doesNotThrow(() => parseRequest({ input: 'Hi', ...controls }));
  assert.doesNotThrow(() => parseRequest({ messages: [{ role: 'user', content: 'Hi' }], ...controls }, true));
  for (const invalid of [{ temperature: 2.1 }, { top_p: 1.1 }, { frequency_penalty: -2.1 },
    { presence_penalty: 2.1 }, { seed: 1.5 }, { max_tokens: 0 }, { max_completion_tokens: '4096' }]) {
    assert.throws(() => parseRequest({ input: 'Hi', ...invalid }), { status: 400 });
  }
});

test('ignores private Copilot metadata on validated nested protocol objects', () => {
  const toolResult = { role: 'tool', tool_call_id: 'call_1', content: 'done', __copilotMessageSource: 'agent' };
  assert.doesNotThrow(() => parseRequest({ messages: [toolResult] }, true));
  assert.throws(() => parseRequest({ messages: [{ ...toolResult, unexpected_nested_field: true }] }, true), { status: 400 });
});

test('auth protects health and inference; bad requests do not start Codex', async t => {
  let opened = 0;
  const { request } = await setup(t, { sessionFactory: options => { opened++; return factory(options); } });
  assert.equal((await request('/healthz', undefined, { Authorization: 'Bearer wrong' })).status, 401);
  assert.equal((await request('/healthz')).status, 200);
  assert.equal((await request('/v1/responses', { input: 'x', tools: [{}] })).status, 400);
  assert.equal((await request('/v1/responses', { input: 'x' }, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal(opened, 0);
});

test('JSON Responses and Chat Completions round trip through subprocess protocol', async t => {
  const { request } = await setup(t);
  const response = await request('/v1/responses', { input: 'hello', model: 'codex' });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.output[0].content[0].text, 'Hello world');
  assert.equal(body.status, 'completed');
  assert.equal(body.usage.total_tokens, 12);
  const chat = await (await request('/v1/chat/completions', { messages: [{ role: 'user', content: 'hi' }] })).json();
  assert.equal(chat.choices[0].message.content, 'Hello world');
  assert.equal(chat.usage.prompt_tokens, 10);
});

test('Responses SSE lifecycle and completed-item fallback preserve all text', async t => {
  const { request } = await setup(t);
  for (const input of ['hello', 'no-deltas']) {
    const response = await request('/v1/responses', { input, stream: true });
    const text = await response.text();
    const events = text.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
    assert.equal(events[0].type, 'response.created');
    assert.equal(events.at(-1).type, 'response.completed');
    assert.equal(events.filter(e => e.type === 'response.output_text.delta').map(e => e.delta).join(''), 'Hello world');
    assert.deepEqual(events.map(e => e.sequence_number), events.map((_, i) => i));
  }
});

test('Chat SSE emits role, content, usage, and DONE', async t => {
  const { request } = await setup(t);
  const response = await request('/v1/chat/completions', { messages: [{ role: 'user', content: 'hi' }], stream: true, stream_options: { include_usage: true } });
  const text = await response.text();
  assert.match(text, /"role":"assistant"/);
  assert.match(text, /"finish_reason":"stop"/);
  assert.match(text, /"total_tokens":12/);
  assert.ok(text.endsWith('data: [DONE]\n\n'));
});

test('readiness and model discovery use the account-authenticated backend', async t => {
  const { request } = await setup(t);
  assert.equal((await request('/readyz')).status, 200);
  const result = await (await request('/v1/models')).json();
  assert.deepEqual(result.data.map(m => m.id), ['codex', 'test-model']);
});

test('API key account rejected before creating a turn', async t => {
  const { request } = await setup(t, { sessionFactory: options => factory(options, 'apiKey') });
  const result = await request('/v1/responses', { input: 'hello' });
  assert.equal(result.status, 503);
  assert.equal((await result.json()).error.code, 'chatgpt_login_required');
});

test('upstream failures and streamed errors do not look like successful completion', async t => {
  const { request } = await setup(t);
  const result = await request('/v1/responses', { input: 'fail' });
  assert.equal(result.status, 429);
  const streamed = await request('/v1/responses', { input: 'fail', stream: true });
  const text = await streamed.text();
  assert.match(text, /response.failed/);
  assert.doesNotMatch(text, /response.completed/);
});

test('timeout, process crash, and interactive request terminate and clean up', async () => {
  for (const [prompt, status] of [['hang', 504], ['crash', 502], ['interactive', 422]]) {
    const session = factory({ timeoutMs: prompt === 'hang' ? 400 : 5000 });
    try {
      await session.open();
      await assert.rejects(session.run({ prompt }, () => {}), { status });
    } finally { await session.close(); }
    await assert.rejects(access(session.cwd));
    assert.ok(session.child.exitCode !== null || session.child.signalCode !== null);
  }
});

test('concurrency limit rejects excess work and disconnect cancels the backend', async t => {
  const sessions = [];
  const { request, url } = await setup(t, { maxConcurrent: 1, sessionFactory: options => {
    const session = factory(options); sessions.push(session); return session;
  } });
  const pending = http.request(url + '/v1/responses', { method: 'POST', headers: {
    Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
  } });
  pending.on('error', () => {});
  pending.end(JSON.stringify({ input: 'hang', stream: true }));
  const [response] = await once(pending, 'response');
  response.resume();
  assert.equal((await request('/v1/responses', { input: 'hi' })).status, 429);
  pending.destroy();
  await sessions[0].exited;
  assert.equal(sessions[0].failure.code, 'cancelled');
});

test('missing binary returns an actionable error', async () => {
  const session = new CodexSession({ bin: '/nonexistent/codex-bridge-test' });
  try { await assert.rejects(session.open(), { status: 503 }); }
  finally { await session.close(); }
});


test('oversized and malformed JSON receive explicit HTTP errors', async t => {
  const { request, url } = await setup(t, { maxBodyBytes: 64 });
  assert.equal((await request('/v1/responses', { input: 'x'.repeat(100) })).status, 413);
  const malformed = await fetch(url + '/v1/responses', { method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{' });
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).error.message, 'Invalid JSON body.');
});


test('simple gateway key authenticates while absent or incorrect keys are rejected', async t => {
  const { url } = await setup(t, { token: 'example-test-token' });
  for (const [key, expected] of [[null, 401], ['wrong', 401], ['example-test-token', 200]]) {
    const response = await fetch(url + '/healthz', { headers: key ? { Authorization: `Bearer ${key}` } : {} });
    assert.equal(response.status, expected);
    await response.text();
  }
  for (const token of [undefined, '', '   ']) assert.throws(() => createBridge({ token }), /nonempty/);
});

const functionTool = { type: 'function', name: 'read_file', description: 'Read a file on the client',
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } };
const chatTool = { type: 'function', function: { name: functionTool.name, description: functionTool.description, parameters: functionTool.parameters } };
const functionCalls = response => response.output.filter(item => item.type === 'function_call');
const toolResult = (call, output = 'file contents') => ({ type: 'function_call_output', call_id: call.call_id, output });
const eventData = text => text.split('\n').filter(line => line.startsWith('data: ') && line !== 'data: [DONE]').map(line => JSON.parse(line.slice(6)));

test('Responses native function call resumes the same subprocess with actual tool results', async t => {
  let opened = 0;
  const { request } = await setup(t, { sessionFactory: options => { opened++; return factory(options); } });
  const first = await (await request('/v1/responses', { input: 'tools', tools: [functionTool], tool_choice: 'required' })).json();
  const [call] = functionCalls(first);
  assert.equal(call.name, 'read_file');
  assert.deepEqual(JSON.parse(call.arguments), { path: 'README.md' });
  assert.equal(first.output.some(item => item.type === 'message'), false);
  const health = await (await request('/healthz')).json();
  assert.equal(health.pending_tool_sessions, 1);
  const next = await request('/v1/responses', { previous_response_id: first.id, input: [toolResult(call, 'actual client data')] });
  assert.equal(next.status, 200);
  assert.equal((await next.json()).output_text, 'actual client data');
  assert.equal(opened, 1);
  assert.equal((await request('/v1/responses', { input: [toolResult(call)] })).status, 410);
});

test('Chat streaming emits only valid chunks, with tool-call indices and finish reason', async t => {
  const { request } = await setup(t);
  const messages = [{ role: 'user', content: 'tools' }];
  const first = await request('/v1/chat/completions', { messages, tools: [chatTool], stream: true });
  const wire = await first.text();
  const events = eventData(wire);
  for (const event of events) assert.equal(event.object, 'chat.completion.chunk');
  const chunks = events.flatMap(event => event.choices.flatMap(choice => choice.delta.tool_calls || []));
  assert.equal(chunks[0].index, 0);
  assert.equal(chunks[0].function.name, 'read_file');
  assert.equal(events.at(-1).choices[0].finish_reason, 'tool_calls');
  assert.ok(wire.endsWith('data: [DONE]\n\n'));
  const toolCall = { id: chunks[0].id, type: 'function', function: { name: chunks[0].function.name, arguments: chunks.map(c => c.function.arguments || '').join('') } };
  const second = await request('/v1/chat/completions', { tools: [chatTool], messages: [...messages,
    { role: 'assistant', content: null, tool_calls: [toolCall] }, { role: 'tool', tool_call_id: toolCall.id, content: 'read from IDE' }], stream: true });
  const output = eventData(await second.text());
  for (const chunk of output) assert.equal(chunk.object, 'chat.completion.chunk');
  assert.equal(output.map(c => c.choices[0]?.delta.content || '').join(''), 'read from IDE');
  assert.equal(output.at(-1).choices[0].finish_reason, 'stop');
});

test('Responses SSE function items, argument deltas, and completion agree', async t => {
  const { request } = await setup(t);
  const response = await request('/v1/responses', { input: 'tools', tools: [functionTool], stream: true });
  const events = eventData(await response.text());
  const added = events.find(e => e.type === 'response.output_item.added');
  assert.equal(added.item.type, 'function_call');
  const delta = events.find(e => e.type === 'response.function_call_arguments.delta');
  const done = events.find(e => e.type === 'response.function_call_arguments.done');
  const completed = events.at(-1).response;
  assert.equal(delta.delta, completed.output[0].arguments);
  assert.equal(done.arguments, delta.delta);
  assert.equal(delta.output_index, added.output_index);
  assert.equal(delta.item_id, added.item.id);
  const next = await request('/v1/responses', { input: [toolResult(functionCalls(completed)[0], 'SSE round trip')], stream: true });
  const continuation = eventData(await next.text());
  assert.equal(continuation.at(-1).response.output_text, 'SSE round trip');
});

test('multiple parallel tool results are correlated and mixed or partial batches preserve the session', async t => {
  const { request } = await setup(t);
  const first = await (await request('/v1/responses', { input: 'two-tools', tools: [functionTool] })).json();
  const calls = functionCalls(first);
  assert.equal(calls.length, 2);
  assert.equal((await request('/v1/responses', { input: [toolResult(calls[0])] })).status, 400);
  assert.equal((await request('/v1/responses', { input: [toolResult(calls[0]), toolResult({ call_id: 'unknown' })] })).status, 400);
  const next = await request('/v1/responses', { input: [toolResult(calls[1], 'second'), toolResult(calls[0], 'first')] });
  assert.equal(next.status, 200);
  assert.equal((await next.json()).output_text, 'second|first');
});

test('parallel_tool_calls:false serializes native parallel requests across HTTP responses', async t => {
  const { request } = await setup(t);
  const first = await (await request('/v1/responses', { input: 'two-tools', tools: [functionTool], parallel_tool_calls: false })).json();
  assert.equal(functionCalls(first).length, 1);
  const second = await (await request('/v1/responses', { input: [toolResult(functionCalls(first)[0], 'one')] })).json();
  assert.equal(functionCalls(second).length, 1);
  const third = await (await request('/v1/responses', { input: [toolResult(functionCalls(second)[0], 'two')] })).json();
  assert.equal(third.output_text, 'one|two');
});

test('repeated tool rounds continue one turn without losing prior results', async t => {
  const { request } = await setup(t);
  const first = await (await request('/v1/responses', { input: 'multi-round', tools: [functionTool] })).json();
  const second = await (await request('/v1/responses', { previous_response_id: first.id, input: [toolResult(functionCalls(first)[0], 'round one')] })).json();
  assert.equal(functionCalls(second).length, 1);
  const third = await (await request('/v1/responses', { previous_response_id: second.id, input: [toolResult(functionCalls(second)[0], 'round two')] })).json();
  assert.equal(third.output_text, 'round one|round two');
});

test('expired waiting turns are killed and do not silently regenerate missing results', async t => {
  const sessions = [];
  const { request } = await setup(t, { toolTimeoutMs: 100, sessionFactory: options => { const s = factory(options); sessions.push(s); return s; } });
  const first = await (await request('/v1/responses', { input: 'tools', tools: [functionTool] })).json();
  await sessions[0].exited;
  assert.equal((await request('/v1/responses', { input: [toolResult(functionCalls(first)[0])] })).status, 410);
});

test('waiting sessions are bounded but a continuation can use its existing slot', async t => {
  const { request } = await setup(t, { maxSessions: 1 });
  const first = await (await request('/v1/responses', { input: 'tools', tools: [functionTool] })).json();
  const busy = await request('/v1/responses', { input: 'hello' });
  assert.equal(busy.status, 429);
  assert.equal((await busy.json()).error.code, 'session_limit');
  const next = await request('/v1/responses', { input: [toolResult(functionCalls(first)[0])] });
  assert.equal(next.status, 200);
});

test('none, named, and required tool choices are enforced', async t => {
  const { request } = await setup(t);
  const none = await (await request('/v1/responses', { input: 'tools', tools: [functionTool], tool_choice: 'none' })).json();
  assert.equal(functionCalls(none).length, 0);
  const named = await (await request('/v1/responses', { input: 'tools', tools: [functionTool, { ...functionTool, name: 'other' }],
    tool_choice: { type: 'function', name: 'other' } })).json();
  assert.equal(functionCalls(named)[0].name, 'other');
  const required = await request('/v1/responses', { input: 'hello', tools: [functionTool], tool_choice: 'required' });
  assert.equal(required.status, 502);
  assert.equal((await required.json()).error.code, 'tool_choice_not_satisfied');
});

test('unknown native tools and changed continuation config are rejected', async t => {
  const { request } = await setup(t);
  assert.equal((await request('/v1/responses', { input: 'unknown-tool', tools: [functionTool] })).status, 502);
  const first = await (await request('/v1/responses', { input: 'tools', tools: [functionTool] })).json();
  const result = toolResult(functionCalls(first)[0]);
  assert.equal((await request('/v1/responses', { input: [result], tools: [] })).status, 400);
  assert.equal((await request('/v1/responses', { input: [result] })).status, 200);
});

test('malformed tools, results, and unsupported strict mode are rejected', () => {
  for (const body of [
    { input: 'x', tools: [functionTool, functionTool] },
    { input: 'x', tools: [{ ...functionTool, strict: true }] },
    { input: 'x', tools: [{ ...functionTool, parameters: 'invalid' }] },
    { input: 'x', tools: [functionTool], tool_choice: { type: 'function', name: 'missing' } },
    { input: [{ type: 'function_call_output', call_id: '', output: 'x' }] },
    { input: 'x', parallel_tool_calls: 'false' },
  ]) assert.throws(() => parseRequest(body), { status: 400 });
});


test('simultaneous duplicate continuations resume a native call only once', async t => {
  const { request } = await setup(t);
  const first = await (await request('/v1/responses', { input: 'tools', tools: [functionTool] })).json();
  const body = { input: [toolResult(functionCalls(first)[0], 'only once')] };
  const replies = await Promise.all([request('/v1/responses', body), request('/v1/responses', body)]);
  assert.deepEqual(replies.map(r => r.status).sort(), [200, 410]);
  for (const reply of replies) await reply.text();
});

test('backend exit and service shutdown clean up parked sessions', async t => {
  const sessions = [];
  const { request, server } = await setup(t, { sessionFactory: options => { const s = factory(options); sessions.push(s); return s; } });
  const first = await (await request('/v1/responses', { input: 'tools', tools: [functionTool] })).json();
  sessions[0].child.kill('SIGTERM');
  await sessions[0].exited;
  assert.equal((await request('/v1/responses', { input: [toolResult(functionCalls(first)[0])] })).status, 410);
  await (await request('/v1/responses', { input: 'tools', tools: [functionTool] })).json();
  server.shutdown();
  await sessions[1].exited;
  await sessions[1].close();
  await assert.rejects(access(sessions[1].cwd));
});

test('tool-call parser rejects null calls without an internal server error', () => {
  assert.throws(() => parseRequest({ messages: [{ role: 'assistant', content: null, tool_calls: [null] }] }, true), { status: 400 });
});


test('Copilot refusal:null assistant replay continues a tool with a no-matches result', async t => {
  const { request } = await setup(t);
  const messages = [{ role: 'user', content: 'tools' }];
  const first = await (await request('/v1/chat/completions', { messages, tools: [chatTool] })).json();
  const assistant = { ...first.choices[0].message, refusal: null };
  const result = 'No files matched the pattern **/AGENTS.md.';
  const next = await request('/v1/chat/completions', { tools: [chatTool], messages: [...messages, assistant,
    { role: 'tool', tool_call_id: assistant.tool_calls[0].id, content: result }] });
  assert.equal(next.status, 200);
  const answer = await next.json();
  assert.equal(answer.choices[0].message.content, result);
  assert.equal(answer.choices[0].finish_reason, 'stop');
});

test('assistant refusal text is preserved and nullable tool metadata is accepted', () => {
  const parsed = parseRequest({ messages: [
    { role: 'user', content: 'Earlier question' },
    { role: 'assistant', content: null, refusal: 'I cannot help with that request.', tool_calls: null },
    { role: 'assistant', content: 'Some other answer', refusal: null, tool_calls: [] },
    { role: 'user', content: 'New question' },
  ] }, true);
  assert.match(parsed.prompt, /I cannot help with that request/);
  assert.match(parsed.prompt, /Some other answer/);
  assert.throws(() => parseRequest({ messages: [
    { role: 'user', content: 'x' }, { role: 'assistant', content: 'y', refusal: {} },
  ] }, true), { status: 400 });
});
