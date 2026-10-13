import { randomUUID } from 'node:crypto';
import { BridgeError } from './codex.mjs';

export function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}
function usage(value, chat) {
  if (!value) return null;
  if (chat) return { prompt_tokens: value.inputTokens, completion_tokens: value.outputTokens, total_tokens: value.totalTokens,
    prompt_tokens_details: { cached_tokens: value.cachedInputTokens }, completion_tokens_details: { reasoning_tokens: value.reasoningOutputTokens } };
  return { input_tokens: value.inputTokens, output_tokens: value.outputTokens, total_tokens: value.totalTokens,
    input_tokens_details: { cached_tokens: value.cachedInputTokens }, output_tokens_details: { reasoning_tokens: value.reasoningOutputTokens } };
}

export class Output {
  constructor(res, body, request, chat, controller) {
    Object.assign(this, { res, body, request, chat, controller });
    this.id = randomUUID().replaceAll('-', '');
    this.sequence = 0;
    this.bytes = 0;
    this.calls = [];
    this.response = { id: `resp_${this.id}`, object: 'response', created_at: Math.floor(Date.now() / 1000),
      status: 'in_progress', model: request.model || 'codex', output: [], error: null, incomplete_details: null,
      usage: null, tools: request.tools || [], tool_choice: typeof request.toolChoice === 'object'
        ? { type: 'function', name: request.toolChoice.name } : request.toolChoice,
      parallel_tool_calls: request.parallel, store: false, metadata: body.metadata || {} };
  }

  send(type, data) {
    if (!this.streaming || this.res.destroyed || this.res.writableEnded) return;
    if (this.res.writableLength > 1048576) { this.controller.abort(); this.res.destroy(); return; }
    const payload = this.chat ? data : { type, sequence_number: this.sequence++, ...data };
    this.res.write(`${this.chat ? '' : `event: ${type}\n`}data: ${JSON.stringify(payload)}\n\n`);
  }

  chunk(delta, finish = null) {
    return { id: `chatcmpl_${this.id}`, object: 'chat.completion.chunk', created: this.response.created_at,
      model: this.response.model, choices: [{ index: 0, delta, finish_reason: finish }] };
  }

  start(model) {
    this.response.model = model;
    if (!this.body.stream) return;
    this.streaming = true;
    this.res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    this.res.flushHeaders();
    this.heartbeat = setInterval(() => {
      if (this.res.writableLength > 1048576) { this.controller.abort(); this.res.destroy(); }
      else this.res.write(': keepalive\n\n');
    }, 15000);
    if (this.chat) this.send(null, this.chunk({ role: 'assistant', content: '' }));
    else {
      this.send('response.created', { response: this.response });
      this.send('response.in_progress', { response: this.response });
    }
  }

  delta(text) {
    this.bytes += Buffer.byteLength(text);
    if (this.bytes > 8388608) throw new BridgeError(502, 'Codex output exceeded 8 MiB.', 'output_too_large');
    if (!this.message) {
      const item = { id: 'msg_' + randomUUID().replaceAll('-', ''), type: 'message', status: 'in_progress', role: 'assistant', content: [] };
      this.messageIndex = this.response.output.length;
      this.response.output.push(item);
      this.message = item;
      if (!this.chat) this.send('response.output_item.added', { output_index: this.messageIndex, item });
      item.content.push({ type: 'output_text', text: '', annotations: [], logprobs: [] });
      if (!this.chat) this.send('response.content_part.added', { item_id: item.id, output_index: this.messageIndex, content_index: 0, part: item.content[0] });
    }
    this.message.content[0].text += text;
    if (this.chat) this.send(null, this.chunk({ content: text }));
    else this.send('response.output_text.delta', { item_id: this.message.id, output_index: this.messageIndex, content_index: 0, delta: text, logprobs: [] });
  }

  endMessage() {
    if (!this.message) return;
    const item = this.message;
    const part = item.content[0];
    item.status = 'completed';
    if (!this.chat) {
      this.send('response.output_text.done', { item_id: item.id, output_index: this.messageIndex, content_index: 0, text: part.text, logprobs: [] });
      this.send('response.content_part.done', { item_id: item.id, output_index: this.messageIndex, content_index: 0, part });
      this.send('response.output_item.done', { output_index: this.messageIndex, item });
    }
    this.message = null;
  }

  tool(call) {
    this.bytes += Buffer.byteLength(call.arguments);
    if (this.bytes > 8388608) throw new BridgeError(502, 'Codex output exceeded 8 MiB.', 'output_too_large');
    this.endMessage();
    const index = this.calls.length;
    const tool = { id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } };
    this.calls.push(tool);
    const outputIndex = this.response.output.length;
    const item = { id: 'fc_' + randomUUID().replaceAll('-', ''), type: 'function_call', call_id: call.id,
      name: call.name, arguments: '', status: 'in_progress' };
    this.response.output.push(item);
    if (this.chat) {
      this.send(null, this.chunk({ tool_calls: [{ index, id: call.id, type: 'function', function: { name: call.name, arguments: '' } }] }));
      this.send(null, this.chunk({ tool_calls: [{ index, function: { arguments: call.arguments } }] }));
    } else {
      this.send('response.output_item.added', { output_index: outputIndex, item });
      this.send('response.function_call_arguments.delta', { item_id: item.id, output_index: outputIndex, delta: call.arguments });
      this.send('response.function_call_arguments.done', { item_id: item.id, output_index: outputIndex, arguments: call.arguments });
    }
    item.arguments = call.arguments;
    item.status = 'completed';
    if (!this.chat) this.send('response.output_item.done', { output_index: outputIndex, item });
  }

  event(type, data) {
    if (type === 'start') this.start(data.model);
    else if (type === 'delta') this.delta(data.text);
    else if (type === 'tool') this.tool(data);
  }

  finish(result) {
    this.endMessage();
    const tokens = usage(result.usage, this.chat);
    if (this.chat) {
      const reason = this.calls.length ? 'tool_calls' : 'stop';
      if (this.streaming) {
        this.send(null, this.chunk({}, reason));
        if (this.body.stream_options?.include_usage) this.send(null, { ...this.chunk({}), choices: [], usage: tokens });
        this.res.end('data: [DONE]\n\n');
      } else json(this.res, 200, { id: `chatcmpl_${this.id}`, object: 'chat.completion', created: this.response.created_at,
        model: result.model, choices: [{ index: 0, message: { role: 'assistant', content: result.text || null,
          ...(this.calls.length ? { tool_calls: this.calls } : {}) }, finish_reason: reason }], usage: tokens });
    } else {
      this.response = { ...this.response, status: 'completed', completed_at: Math.floor(Date.now() / 1000),
        model: result.model, output_text: result.text, usage: tokens };
      if (this.streaming) { this.send('response.completed', { response: this.response }); this.res.end(); }
      else json(this.res, 200, this.response);
    }
  }

  error(error) {
    const status = error.status || 500;
    const payload = { message: status === 500 ? 'Internal bridge error.' : error.message,
      type: status < 500 ? 'invalid_request_error' : 'server_error', code: error.code || 'internal_error' };
    if (this.res.destroyed || this.res.writableEnded) return;
    if (this.streaming) {
      if (this.chat) this.send(null, { error: payload });
      else this.send('response.failed', { response: { ...this.response, status: 'failed', error: payload } });
      this.res.end();
    } else json(this.res, status, { error: payload });
  }

  close() { clearInterval(this.heartbeat); }
}
