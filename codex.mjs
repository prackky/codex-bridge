import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export class BridgeError extends Error {
  constructor(status, message, code = 'bridge_error') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// A process owns one turn, retained across HTTP requests while client tools run.
export class CodexSession {
  constructor({ bin = 'codex', timeoutMs = 180000, signal, spawnProcess = spawn } = {}) {
    this.options = { bin, timeoutMs, signal, spawnProcess };
    this.pending = new Map();
    this.nextId = 0;
    this.onNotification = () => {};
    this.closed = false;
    this.toolRequests = new Map();
    this.toolNames = new Map();
    this.queuedEvents = [];
    this.itemTexts = new Map();
    this.onFailure = () => {};
    this.failure = null;
    this.done = new Promise((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
    // A startup failure may precede the caller awaiting the turn promise.
    this.done.catch(() => {});
  }

  fail(error) {
    if (this.failure) return;
    this.failure = error;
    for (const { reject } of this.pending.values()) reject(error);
    this.pending.clear();
    this.reject(error);
    this.onFailure(error);
    this.child?.kill('SIGTERM');
    this.killTimer = setTimeout(() => this.child?.kill('SIGKILL'), 1500);
    this.killTimer.unref();
  }

  send(message) {
    if (this.failure) throw this.failure;
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }

  rpc(method, params = {}) {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      this.pending.set(id, { resolve, reject });
      try { this.send({ id, method, params }); }
      catch (error) { this.pending.delete(id); reject(error); }
    });
  }

  async open() {
    const { bin, signal, timeoutMs, spawnProcess } = this.options;
    if (signal?.aborted) throw new BridgeError(499, 'Client disconnected.', 'cancelled');
    this.cwd = await mkdtemp(join(tmpdir(), 'codex-bridge-'));
    const overrides = {
      model_provider: 'openai', approval_policy: 'never', sandbox_mode: 'read-only',
      web_search: 'disabled', 'features.code_mode_host': true,
    };
    for (const feature of ['shell_tool', 'unified_exec', 'apps', 'plugins', 'hooks',
      'multi_agent', 'multi_agent_v2', 'browser_use', 'computer_use', 'image_generation',
      'view_image', 'memories', 'skill_search', 'shell_snapshot', 'code_mode']) {
      overrides[`features.${feature}`] = false;
    }
    const args = ['app-server', '--listen', 'stdio://'];
    for (const [key, value] of Object.entries(overrides)) args.push('-c', `${key}=${JSON.stringify(value)}`);
    const env = { ...process.env };
    // Never select API-key billing through inherited environment variables.
    for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL', 'BRIDGE_TOKEN']) delete env[key];
    this.child = spawnProcess(bin, args, { cwd: this.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.exited = new Promise(resolve => this.child.once('close', resolve));
    this.child.stderr.resume(); // Do not log prompts, credentials, or upstream diagnostics.
    this.child.on('error', () => this.fail(new BridgeError(503, 'Cannot start Codex. Check CODEX_BIN.', 'codex_unavailable')));
    this.child.stdin.on('error', () => this.fail(new BridgeError(502, 'Codex connection closed.', 'codex_disconnected')));
    this.child.on('exit', () => {
      if (!this.closed) this.fail(new BridgeError(502, 'Codex exited before completing the request.', 'codex_exited'));
    });
    this.reader = createInterface({ input: this.child.stdout });
    this.reader.on('line', line => {
      try {
        const message = JSON.parse(line);
        if (message.method && message.id !== undefined) {
          if (message.method === 'item/tool/call') this.acceptToolCall(message);
          else {
            this.send({ id: message.id, error: { code: -32601, message: 'Interactive approval requests are unavailable.' } });
            this.fail(new BridgeError(422, 'Codex requested an unsupported interactive approval.', 'unsupported_tool'));
          }
        } else if (message.id !== undefined) {
          const pending = this.pending.get(message.id);
          if (!pending) return;
          this.pending.delete(message.id);
          if (message.error) pending.reject(new BridgeError(502, message.error.message || 'Codex request failed.', 'codex_error'));
          else pending.resolve(message.result);
        } else if (message.method) this.onNotification(message.method, message.params || {});
      } catch (error) {
        this.fail(error instanceof BridgeError ? error : new BridgeError(502, 'Invalid Codex protocol response.', 'protocol_error'));
      }
    });
    this.attach(signal);
    await this.rpc('initialize', { clientInfo: { name: 'codex_intranet_bridge', version: '0.2.0' },
      capabilities: { experimentalApi: true } });
    this.send({ method: 'initialized', params: {} });
    const { account } = await this.rpc('account/read', { refreshToken: false });
    if (account?.type !== 'chatgpt') {
      throw new BridgeError(503, 'ChatGPT login required. Run codex login on the gateway host as the service user.', 'chatgpt_login_required');
    }
    return this;
  }

  async models() {
    const models = [];
    let cursor;
    do {
      const page = await this.rpc('model/list', { limit: 100, ...(cursor ? { cursor } : {}) });
      models.push(...page.data);
      cursor = page.nextCursor;
    } while (cursor);
    return models;
  }

  attach(signal) {
    this.detach();
    this.signal = signal;
    this.abort = () => this.fail(new BridgeError(499, 'Client disconnected.', 'cancelled'));
    signal?.addEventListener('abort', this.abort, { once: true });
    this.timer = setTimeout(() => this.fail(new BridgeError(504, 'Codex request timed out.', 'timeout')), this.options.timeoutMs);
    if (signal?.aborted) this.abort();
  }

  detach() {
    clearTimeout(this.timer);
    this.signal?.removeEventListener('abort', this.abort);
    this.signal = null;
  }

  beginPhase(emit) {
    if (this.failure) throw this.failure;
    this.done = new Promise((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
    this.done.catch(() => {});
    this.phaseText = '';
    this.emit = emit;
    this.phaseActive = true;
  }

  event(type, data) {
    if (!this.phaseActive) { this.queuedEvents.push([type, data]); return; }
    if (type === 'delta') this.phaseText += data.text;
    this.emit(type, data);
  }

  finishPhase(waiting = false) {
    if (!this.phaseActive) return;
    const calls = waiting ? [...this.toolRequests.values()].filter(t => !t.advertised)
      .slice(0, this.request.parallel === false ? 1 : 128) : [];
    if (waiting && !calls.length) return;
    const toolCalls = calls.map(entry => {
      entry.advertised = true;
      const value = { id: entry.id, name: entry.name, arguments: JSON.stringify(entry.arguments) };
      this.event('tool', value);
      return value;
    });
    this.phaseActive = false;
    let usage = null;
    if (this.usage) {
      usage = Object.fromEntries(Object.entries(this.usage).map(([key, value]) => [key, Math.max(0, value - (this.reportedUsage?.[key] || 0))]));
      this.reportedUsage = { ...this.usage };
    }
    this.resolve({ text: this.phaseText, model: this.model, usage, toolCalls });
  }

  scheduleTools() {
    if (this.toolFlush) return;
    this.toolFlush = setTimeout(() => {
      this.toolFlush = null;
      try { this.finishPhase(true); }
      catch (error) { this.fail(error); }
    }, 20);
  }

  acceptToolCall(message) {
    const params = message.params || {};
    const name = this.toolNames.get(params.tool);
    if (!name || params.threadId !== this.threadId || params.namespace ||
        !params.arguments || typeof params.arguments !== 'object' || Array.isArray(params.arguments)) {
      throw new BridgeError(502, 'Codex requested an undeclared or malformed client tool.', 'invalid_tool_call');
    }
    if (this.toolRequests.size >= 128) throw new BridgeError(502, 'Too many pending tool calls.', 'tool_limit');
    const id = 'call_' + randomUUID().replaceAll('-', '');
    this.toolRequests.set(id, { id, rpcId: message.id, name, arguments: params.arguments, advertised: false });
    this.calledTool = true;
    this.scheduleTools();
  }

  async run(request, emit) {
    this.request = request;
    this.beginPhase(emit);
    const { model, instructions, prompt, effort, toolChoice = 'none' } = request;
    const tools = (request.tools || []).filter(tool => toolChoice !== 'none' &&
      (typeof toolChoice !== 'object' || tool.name === toolChoice.name));
    const dynamicTools = tools.map((tool, index) => {
      const name = 'bridge_tool_' + index;
      this.toolNames.set(name, tool.name);
      return { type: 'function', name, description: 'Client workspace function ' + tool.name + ': ' + tool.description, inputSchema: tool.parameters };
    });
    const { config } = await this.rpc('config/read', { includeLayers: false });
    // Host sandbox prose describes the gateway, not the IDE workspace.
    // Keep enforcement read-only, but use scoped instructions for remote tools.
    const threadConfig = dynamicTools.length ? { include_permissions_instructions: false } : {};
    for (const name of Object.keys(config?.mcp_servers || {})) threadConfig[`mcp_servers.${name}.enabled`] = false;
    const toolInstructions = dynamicTools.length
      ? [
          'You are serving an IDE workspace on a separate client machine through a gateway.',
          'The supplied bridge_tool functions execute in that client workspace, subject to the IDE permissions and approval flow.',
          'Gateway filesystem sandbox and approval settings apply only to this gateway host. They do not describe permissions of client tools.',
          'For user-requested changes, use the supplied client editing and test or terminal functions when available. Do not infer that those tools are read-only from gateway settings.',
          'Respect actual client tool errors and denied approvals. Report a permission blocker only when a client tool or explicit client policy establishes it.',
          'Never claim edits or test success without the corresponding tool results.',
          'Use only supplied bridge_tool functions. Do not inspect gateway files or use gateway shell, apps, plugins, or other built-in tools.',
        ].join(' ')
      : 'Respond to the supplied text. Do not use tools, inspect local files, or execute commands.';
    const forced = toolChoice === 'required' || typeof toolChoice === 'object';
    const started = await this.rpc('thread/start', {
      model: model || null, modelProvider: 'openai', cwd: this.cwd,
      approvalPolicy: 'never', sandbox: 'read-only', ephemeral: true, dynamicTools,
      config: threadConfig,
      developerInstructions: [toolInstructions,
        forced ? 'You must call one of the supplied functions before giving your final answer.' : '', instructions].filter(Boolean).join('\n\n'),
    });
    this.threadId = started.thread.id;
    this.model = started.model || model || 'codex';
    this.event('start', { model: this.model });
    this.onNotification = (method, params) => {
      if (params.threadId !== this.threadId) return;
      if (method === 'item/agentMessage/delta') {
        this.itemTexts.set(params.itemId, (this.itemTexts.get(params.itemId) || '') + params.delta);
        this.event('delta', { text: params.delta });
      }
      if (method === 'item/completed' && params.item?.type === 'agentMessage') {
        const previous = this.itemTexts.get(params.item.id) || '';
        const text = params.item.text || previous;
        if (text.startsWith(previous) && text.length > previous.length) this.event('delta', { text: text.slice(previous.length) });
        this.itemTexts.set(params.item.id, text);
      }
      if (method === 'thread/tokenUsage/updated') this.usage = params.tokenUsage?.last || null;
      if (method === 'turn/completed') {
        if (params.turn.status !== 'completed') {
          const info = params.turn.error?.codexErrorInfo;
          const limited = info === 'usageLimitExceeded' || info === 'rateLimitExceeded';
          this.fail(new BridgeError(limited ? 429 : 502, params.turn.error?.message || `Codex turn ${params.turn.status}.`,
            limited ? 'rate_limit_exceeded' : 'codex_turn_failed'));
        } else if (forced && !this.calledTool) {
          this.fail(new BridgeError(502, 'Codex completed without the required tool call.', 'tool_choice_not_satisfied'));
        } else if (this.toolRequests.size) {
          this.fail(new BridgeError(502, 'Codex completed with unresolved client tools.', 'protocol_error'));
        } else this.finishPhase();
      }
    };
    await this.rpc('turn/start', { threadId: this.threadId, input: [{ type: 'text', text: prompt }], ...(effort ? { effort } : {}) });
    return this.done;
  }

  async continue(results, emit, signal) {
    this.attach(signal);
    this.beginPhase(emit);
    this.event('start', { model: this.model });
    for (const [type, data] of this.queuedEvents.splice(0)) this.event(type, data);
    // Validate the whole batch before sending any result to Codex.
    const outstanding = [...this.toolRequests.values()].filter(t => t.advertised);
    if (results.length !== outstanding.length || results.some(r => !this.toolRequests.get(r.call_id)?.advertised) ||
        new Set(results.map(r => r.call_id)).size !== results.length) {
      throw new BridgeError(400, 'Supply exactly one result for every returned tool call.', 'invalid_tool_results');
    }
    for (const result of results) {
      const entry = this.toolRequests.get(result.call_id);
      this.send({ id: entry.rpcId, result: { contentItems: [{ type: 'inputText', text: result.output }], success: true } });
      this.toolRequests.delete(result.call_id);
    }
    // A native parallel call can arrive after the preceding HTTP response finished.
    this.scheduleTools();
    return this.done;
  }

  close() {
    return this.closing ||= this.cleanup();
  }

  async cleanup() {
    this.closed = true;
    this.detach();
    clearTimeout(this.toolFlush);
    if (this.child) {
      this.child.kill('SIGTERM');
      const timer = setTimeout(() => this.child.kill('SIGKILL'), 1500);
      await this.exited;
      clearTimeout(timer);
    }
    clearTimeout(this.killTimer);
    this.reader?.close();
    if (this.cwd) await rm(this.cwd, { recursive: true, force: true });
  }
}
