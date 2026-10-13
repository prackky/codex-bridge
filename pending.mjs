import { BridgeError } from './codex.mjs';

// Holds only turns waiting for client tools; completed answers are not stored.
export class PendingTools {
  constructor({ ttlMs = 300000, dispose }) {
    this.ttlMs = ttlMs;
    this.dispose = dispose;
    this.responses = new Map();
    this.calls = new Map();
  }

  park(session, result, responseId, request) {
    if (session.failure) throw session.failure;
    session.detach();
    const entry = { session, request, responseId, ids: result.toolCalls.map(c => c.id) };
    entry.timer = setTimeout(() => this.discard(entry), this.ttlMs);
    entry.timer.unref();
    this.responses.set(responseId, entry);
    for (const id of entry.ids) this.calls.set(id, entry);
    session.onFailure = () => this.discard(entry);
    return entry;
  }

  remove(entry) {
    clearTimeout(entry.timer);
    this.responses.delete(entry.responseId);
    for (const id of entry.ids) this.calls.delete(id);
    entry.session.onFailure = () => {};
  }

  discard(entry) {
    if (this.responses.get(entry.responseId) !== entry) return;
    this.remove(entry);
    void this.dispose(entry.session);
  }

  claim(request) {
    const entry = request.previousResponseId ? this.responses.get(request.previousResponseId)
      : this.calls.get(request.toolResults[0]?.call_id);
    if (!entry) throw new BridgeError(410, 'Tool session is missing, expired, already consumed, or lost after a restart. Start a new request.', 'tool_session_expired');
    const ids = request.toolResults.map(r => r.call_id);
    if (ids.length !== entry.ids.length || new Set(ids).size !== ids.length || ids.some(id => !entry.ids.includes(id))) {
      throw new BridgeError(400, 'Supply exactly one result for every tool call in the preceding response. Do not mix sessions.', 'invalid_tool_results');
    }
    const original = entry.request;
    const changed = (request.model && request.model !== original.model && request.model !== entry.session.model) ||
      (request.tools !== undefined && JSON.stringify(request.tools) !== JSON.stringify(original.tools)) ||
      (request.instructions && request.instructions !== original.instructions) ||
      (request.effort && request.effort !== original.effort) ||
      (request.choiceExplicit && JSON.stringify(request.toolChoice) !== JSON.stringify(original.toolChoice));
    if (changed) throw new BridgeError(400, 'Model, instructions, tools, effort, and tool_choice cannot change during a pending tool turn.', 'tool_session_mismatch');
    this.remove(entry); // Claim before awaiting anything; duplicate submissions cannot resume twice.
    return entry;
  }

  close() {
    for (const entry of [...this.responses.values()]) this.discard(entry);
  }
}
