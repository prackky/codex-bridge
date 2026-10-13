import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { BridgeError, CodexSession } from './codex.mjs';
import { parseRequest } from './request.mjs';
import { Output, json } from './output.mjs';
import { PendingTools } from './pending.mjs';
export { parseRequest } from './request.mjs';
const bad = message => new BridgeError(400, message, 'invalid_request_error');

async function readBody(req, limit) {
  if (!(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) throw new BridgeError(415, 'Use Content-Type: application/json.', 'unsupported_media_type');
  return new Promise((resolve, reject) => {
    let chunks = [], size = 0, rejected = false;
    // Drain rejected chunked bodies so clients can receive the HTTP 413.
    req.on('data', chunk => {
      if (rejected) return;
      size += chunk.length;
      if (size > limit) {
        rejected = true;
        chunks = [];
        reject(new BridgeError(413, 'Request body is too large.', 'request_too_large'));
      } else chunks.push(chunk);
    });
    req.on('end', () => {
      if (rejected) return;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(bad('Invalid JSON body.')); }
    });
    req.on('error', reject);
    req.on('aborted', () => reject(new BridgeError(499, 'Client disconnected.', 'cancelled')));
  });
}

export function createBridge({ token, bin = 'codex', model, reasoningEffort, timeoutMs = 180000,
  maxConcurrent = 2, maxSessions = 8, toolTimeoutMs = 300000, maxBodyBytes = 1048576,
  sessionFactory = options => new CodexSession(options) } = {}) {
  if (typeof token !== 'string' || !token.trim()) throw new Error('BRIDGE_TOKEN must be a nonempty string.');
  let active = 0;
  const controllers = new Set();
  const sessions = new Set();
  const expected = Buffer.from(`Bearer ${token}`);
  const dispose = async session => {
    if (!session) return;
    try { await session.close(); }
    catch { console.error('Failed to clean up a Codex session. Check host permissions.'); }
    finally { sessions.delete(session); }
  };
  const pending = new PendingTools({ ttlMs: toolTimeoutMs, dispose });
  const server = http.createServer(async (req, res) => {
    const controller = new AbortController();
    let session, reserved = false, parked, output;
    res.on('close', () => {
      if (!res.writableFinished) {
        controller.abort();
        if (parked) pending.discard(parked);
      }
    });
    try {
      const received = Buffer.from(req.headers.authorization || '');
      if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
        res.setHeader('WWW-Authenticate', 'Bearer');
        throw new BridgeError(401, 'Invalid gateway token.', 'invalid_api_key');
      }
      const path = new URL(req.url, 'http://localhost').pathname;
      if (req.method === 'GET' && path === '/healthz') {
        return json(res, 200, { status: 'ok', active_requests: active, pending_tool_sessions: pending.responses.size,
          backend: 'codex-app-server', readiness: '/readyz' });
      }
      const readRoute = req.method === 'GET' && ['/readyz', '/v1/models'].includes(path);
      const writeRoute = req.method === 'POST' && ['/v1/responses', '/v1/chat/completions'].includes(path);
      if (!readRoute && !writeRoute) throw new BridgeError(404, 'Endpoint not found.', 'not_found');
      if (active >= maxConcurrent) {
        res.setHeader('Retry-After', '5');
        throw new BridgeError(429, 'Gateway is busy. Retry shortly.', 'gateway_busy');
      }
      active++;
      reserved = true;
      controllers.add(controller);
      let body, request, continuation;
      const chat = path === '/v1/chat/completions';
      if (writeRoute) {
        body = await readBody(req, maxBodyBytes);
        request = parseRequest(body, chat);
        if (request.toolResults.length) {
          continuation = pending.claim(request);
          session = continuation.session;
          request = { ...continuation.request, toolResults: request.toolResults };
        } else {
          request.model ||= model;
          request.effort ||= reasoningEffort;
        }
      }
      if (!session) {
        if (sessions.size >= maxSessions) {
          res.setHeader('Retry-After', '5');
          throw new BridgeError(429, 'Gateway session limit reached. Complete pending tool calls or wait for expiry.', 'session_limit');
        }
        session = sessionFactory({ bin, timeoutMs, signal: controller.signal });
        sessions.add(session);
        await session.open();
      }
      if (path === '/readyz') return json(res, 200, { status: 'ready', authentication: 'chatgpt' });
      if (path === '/v1/models') {
        const models = await session.models();
        return json(res, 200, { object: 'list', data: [
          { id: 'codex', object: 'model', created: 0, owned_by: 'codex-bridge' },
          ...models.filter(m => !m.hidden).map(m => ({ id: m.model, object: 'model', created: 0, owned_by: 'openai' })),
        ] });
      }
      output = new Output(res, body, request, chat, controller);
      const emit = (type, data) => output.event(type, data);
      const result = continuation ? await session.continue(request.toolResults, emit, controller.signal)
        : await session.run(request, emit);
      if (controller.signal.aborted) throw new BridgeError(499, 'Client disconnected.', 'cancelled');
      if (result.toolCalls?.length) parked = pending.park(session, result, output.response.id, request);
      output.finish(result);
    } catch (error) {
      if (parked) { pending.discard(parked); parked = null; }
      if (output) output.error(error);
      else if (!res.destroyed && !res.writableEnded) {
        const status = error.status || 500;
        json(res, status, { error: { message: status === 500 ? 'Internal bridge error.' : error.message,
          type: status < 500 ? 'invalid_request_error' : 'server_error', code: error.code || 'internal_error' } });
      }
    } finally {
      output?.close();
      if (!parked) await dispose(session);
      controllers.delete(controller);
      if (reserved) active--;
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  server.keepAliveTimeout = 5000;
  server.shutdown = () => {
    for (const controller of controllers) controller.abort();
    pending.close();
    server.close();
    server.closeIdleConnections();
  };
  return server;
}

function integer(name, fallback, min = 1, max = 2147483647) {
  const value = process.env[name] === undefined ? fallback : Number(process.env[name]);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer from ${min} to ${max}.`);
  return value;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const host = process.env.BRIDGE_HOST || '127.0.0.1';
    const port = integer('BRIDGE_PORT', 8765, 1, 65535);
    const server = createBridge({ token: process.env.BRIDGE_TOKEN, bin: process.env.CODEX_BIN || 'codex',
      model: process.env.BRIDGE_MODEL, reasoningEffort: process.env.BRIDGE_REASONING_EFFORT, timeoutMs: integer('BRIDGE_TIMEOUT_MS', 180000),
      maxConcurrent: integer('BRIDGE_MAX_CONCURRENT', 2), maxSessions: integer('BRIDGE_MAX_SESSIONS', 8),
      toolTimeoutMs: integer('BRIDGE_TOOL_TIMEOUT_MS', 300000), maxBodyBytes: integer('BRIDGE_MAX_BODY_BYTES', 1048576) });
    server.on('error', error => { console.error(`Bridge failed to listen: ${error.message}`); process.exitCode = 1; });
    server.listen(port, host, () => console.log(`Codex bridge listening on http://${host}:${port}`));
    for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => server.shutdown());
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
