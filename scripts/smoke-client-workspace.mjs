// Live regression: the client edits and checks an isolated temporary file.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createBridge } from '../server.mjs';
const root = await mkdtemp(join(tmpdir(), 'bridge-client-check-'));
const token = randomBytes(32).toString('hex');
const server = createBridge({ token, reasoningEffort: 'low', timeoutMs: 60000 });
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;
const tools = [
  { type: 'function', function: { name: 'edit_file', description: 'Create or replace demo.txt in the client workspace.',
    parameters: { type: 'object', properties: { content: { type: 'string' } }, required: ['content'], additionalProperties: false } } },
  { type: 'function', function: { name: 'run_tests', description: 'Check demo.txt content in the client workspace.',
    parameters: { type: 'object', properties: {}, additionalProperties: false } } },
];
const messages = [{ role: 'user', content: 'Create demo.txt containing exactly CLIENT_EDIT_OK with no newline using edit_file, then call run_tests. Report whether the tests passed. Both tools operate on my writable client workspace.' }];
let edited = false, tested = false;
try {
  for (let step = 0; step < 6; step++) {
    const response = await fetch(base + '/v1/chat/completions', { method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'codex', messages, tools }) });
    const value = await response.json();
    assert.equal(response.status, 200, JSON.stringify(value));
    const assistant = value.choices[0].message;
    messages.push(assistant);
    if (!assistant.tool_calls?.length) {
      assert.ok(edited && tested, JSON.stringify(assistant));
      console.log(JSON.stringify({ edited, tested, reply: assistant.content, status: 'passed' }));
      break;
    }
    for (const call of assistant.tool_calls) {
      const args = JSON.parse(call.function.arguments);
      let output;
      if (call.function.name === 'edit_file') {
        assert.equal(typeof args.content, 'string');
        await writeFile(join(root, 'demo.txt'), args.content);
        edited = true;
        output = 'Client file demo.txt written successfully.';
      } else {
        assert.equal(call.function.name, 'run_tests');
        assert.equal(await readFile(join(root, 'demo.txt'), 'utf8'), 'CLIENT_EDIT_OK');
        tested = true;
        output = 'Client tests passed: demo.txt contains CLIENT_EDIT_OK.';
      }
      console.log('Executed client tool:', call.function.name);
      messages.push({ role: 'tool', tool_call_id: call.id, content: output });
    }
  }
  assert.ok(edited && tested, 'Expected client edit and test execution');
} finally { server.shutdown(); server.closeAllConnections(); await rm(root, { recursive: true, force: true }); }
