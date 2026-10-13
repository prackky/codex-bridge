import { createInterface } from 'node:readline';
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const notify = (method, params) => send({ method, params: { threadId: 'thread-test', ...params } });
let dynamicTools = [], prompt, nextToolId = 100, round = 0;
const pending = new Map();
const outputs = [];
function complete(text = 'Hello world') {
  notify('item/started', { item: { id: 'item-' + round, type: 'agentMessage' } });
  if (prompt !== 'no-deltas') notify('item/agentMessage/delta', { itemId: 'item-' + round, delta: text.slice(0, 6) });
  notify('item/completed', { item: { id: 'item-' + round, type: 'agentMessage', text } });
  notify('thread/tokenUsage/updated', { tokenUsage: { last: { inputTokens: 10, outputTokens: 2, totalTokens: 12, cachedInputTokens: 3, reasoningOutputTokens: 1 } } });
  notify('turn/completed', { turn: { status: 'completed' } });
}
function tool(name = dynamicTools[0]?.name) {
  const id = nextToolId++;
  pending.set(id, true);
  send({ id, method: 'item/tool/call', params: { threadId: 'thread-test', turnId: 'turn-test', callId: 'native-' + id,
    tool: name, arguments: { path: 'README.md' } } });
}
createInterface({ input: process.stdin }).on('line', line => {
  const { id, method, params, result } = JSON.parse(line);
  const reply = value => send({ id, result: value });
  if (!method && pending.has(id)) {
    if (result.success !== true || result.contentItems[0].type !== 'inputText') process.exit(2);
    pending.delete(id);
    outputs.push(result.contentItems[0].text);
    if (!pending.size) {
      if (prompt === 'multi-round' && round++ === 0) tool();
      else complete(outputs.join('|'));
    }
    return;
  }
  if (method === 'initialize') {
    if (!params.capabilities?.experimentalApi) process.exit(2);
    reply({});
  }
  if (method === 'account/read') reply({ account: { type: process.env.FAKE_AUTH || 'chatgpt' } });
  if (method === 'config/read') reply({ config: { mcp_servers: { demo: { enabled: true } } } });
  if (method === 'model/list') reply({ data: [{ model: 'test-model' }], nextCursor: null });
  if (method === 'thread/start') {
    dynamicTools = params.dynamicTools || [];
    if (params.config['mcp_servers.demo.enabled'] !== false || params.sandbox !== 'read-only' || !params.ephemeral ||
        (dynamicTools.length && (params.config.include_permissions_instructions !== false ||
          !params.developerInstructions.includes('subject to the IDE permissions and approval flow')))) {
      send({ id, error: { message: 'Unsafe thread configuration' } });
    } else reply({ thread: { id: 'thread-test' }, model: 'test-model' });
  }
  if (method === 'turn/start') {
    prompt = params.input[0].text;
    reply({ turn: { id: 'turn-test' } });
    if (prompt === 'hang') return;
    if (prompt === 'crash') return process.exit(1);
    if (prompt === 'interactive') return send({ id: 100, method: 'item/tool/requestUserInput', params: {} });
    if (prompt === 'fail') return notify('turn/completed', { turn: { status: 'failed', error: { message: 'Quota exhausted', codexErrorInfo: 'usageLimitExceeded' } } });
    if (prompt === 'unknown-tool') return tool('not_declared');
    if (dynamicTools.length && ['tools', 'two-tools', 'multi-round', 'late-tools'].includes(prompt)) {
      tool();
      if (prompt === 'two-tools') tool();
      if (prompt === 'late-tools') setTimeout(() => tool(), 60);
      return;
    }
    complete();
  }
});
