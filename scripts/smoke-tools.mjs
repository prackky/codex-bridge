// Optional live test: consumes Codex usage; never executes a real client tool.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { createBridge } from '../server.mjs';
const chat = process.argv[2] === 'chat';
let server;
const token = process.env.BRIDGE_URL ? process.env.BRIDGE_TOKEN : randomBytes(32).toString('hex');
let base = process.env.BRIDGE_URL;
if (!base) {
  server = createBridge({ token, timeoutMs: 90000 });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
}
const fn = { name: 'get_test_value', description: 'Return the test value required to answer the user.',
  parameters: { type: 'object', properties: {}, additionalProperties: false } };
const tools = [chat ? { type: 'function', function: fn } : { type: 'function', ...fn }];
const prompt = 'Call get_test_value once, then reply with only the exact text returned by the tool.';
async function post(body) {
  const response = await fetch(base + (chat ? '/v1/chat/completions' : '/v1/responses'), { method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const wire = await response.text();
  assert.equal(response.status, 200, wire);
  if (!body.stream) return JSON.parse(wire);
  const events = wire.split('\n').filter(line => line.startsWith('data: ') && line !== 'data: [DONE]').map(line => JSON.parse(line.slice(6)));
  if (!chat) {
    const completed = events.find(event => event.type === 'response.completed');
    assert.ok(completed, wire);
    return completed.response;
  }
  const calls = [];
  let content = '', finish;
  for (const event of events) {
    assert.ok(!event.error, JSON.stringify(event));
    assert.equal(event.object, 'chat.completion.chunk');
    for (const choice of event.choices) {
      content += choice.delta.content || '';
      finish = choice.finish_reason || finish;
      for (const part of choice.delta.tool_calls || []) {
        const call = calls[part.index] ||= { id: '', type: 'function', function: { name: '', arguments: '' } };
        call.id ||= part.id;
        call.function.name += part.function?.name || '';
        call.function.arguments += part.function?.arguments || '';
      }
    }
  }
  assert.equal(finish, 'tool_calls');
  assert.ok(wire.endsWith('data: [DONE]\n\n'));
  return { choices: [{ message: { role: 'assistant', content: content || null, tool_calls: calls } }] };
}
try {
  const first = await post({ model: 'codex', tools, tool_choice: 'required', stream: chat,
    ...(chat ? { messages: [{ role: 'user', content: prompt }] } : { input: prompt }) });
  const call = chat ? first.choices[0].message.tool_calls[0] : first.output.find(item => item.type === 'function_call');
  assert.ok(call, JSON.stringify(first));
  assert.equal(chat ? call.function.name : call.name, fn.name);
  const continuation = chat
    ? { messages: [{ role: 'user', content: prompt }, first.choices[0].message, { role: 'tool', tool_call_id: call.id, content: 'TOOL_ROUND_TRIP_OK' }] }
    : { previous_response_id: first.id, input: [{ type: 'function_call_output', call_id: call.call_id, output: 'TOOL_ROUND_TRIP_OK' }] };
  const second = await post({ ...continuation, model: 'codex', stream: !chat });
  const answer = chat ? second.choices[0].message.content : second.output_text;
  assert.equal(answer, 'TOOL_ROUND_TRIP_OK');
  console.log(JSON.stringify({ endpoint: chat ? 'chat/completions' : 'responses', nativeTool: fn.name, reply: answer, status: 'passed' }));
} finally { server?.shutdown(); server?.closeAllConnections(); }
