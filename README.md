# Codex intranet bridge

A dependency-free Node.js HTTP service that forwards text and client function-tool requests to a local
`codex app-server` using its existing **ChatGPT login**. Defaults to port **8765**.
No OpenAI API key is required. The gateway bearer token is a separate, locally
generated secret; it is not your ChatGPT credential.

```text
Work machine → HTTP gateway :8765 → Codex app-server (stdio) → ChatGPT-authenticated Codex
```

## Quick start with Docker (recommended)

Requires Docker with Compose. Each installation uses its own ChatGPT login.

```bash
git clone https://github.com/prackky/codex-bridge.git
cd codex-bridge
docker compose build
docker compose run --rm --no-deps bridge node scripts/setup.mjs
docker compose run --rm --no-deps bridge codex login --device-auth
docker compose up -d
```

The setup command generates `.env` with a random gateway token and never overwrites
an existing configuration. Open the URL printed by Codex and enter the device code.
Device login must be enabled in your ChatGPT security settings or workspace permissions.
Login credentials stay in the Compose `codex-home` volume, outside the image and repository.
The gateway is available at `http://127.0.0.1:8765/v1`. Use the `BRIDGE_TOKEN`
from your local `.env` as the client's API key, and `codex` as the model.

```bash
docker compose exec bridge node scripts/healthcheck.mjs --ready
docker compose logs -f bridge
docker compose restart bridge
docker compose down
```

`down` preserves the login volume; `down -v` deletes it and requires a new login.
See [Deployment](DEPLOYMENT.md) for remote clients, upgrades, port conflicts,
and a browser-login fallback. Never commit `.env` or share your login volume.

## Run without Docker

Requires Node.js 22+ and a Codex CLI exposing `app-server`.

```bash
npm install -g @openai/codex
codex login
node scripts/setup.mjs
npm start
```

`npm start` loads `.env` automatically without overriding environment variables
already set by the shell or service manager. No bridge npm dependencies are required.
Set `CODEX_BIN` to an absolute path if Codex is absent from your service's PATH.
Use the standalone CLI rather than a versioned IDE extension executable.
Run as the OS user who authenticated Codex. An optional `CODEX_HOME` selects a
separate configuration/login directory.

## Test from the other machine

Set `BRIDGE_TOKEN` there to the gateway token and replace the example address:

```bash
export BRIDGE_URL=http://127.0.0.1:8765
read -rsp 'Gateway token: ' BRIDGE_TOKEN
export BRIDGE_TOKEN
curl -sS "$BRIDGE_URL/readyz" -H "Authorization: Bearer $BRIDGE_TOKEN"

curl -sS "$BRIDGE_URL/v1/responses" \
  -H "Authorization: Bearer $BRIDGE_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"model":"codex","input":"Write a Python function that checks whether a string is a palindrome."}'
```

The answer is in `output[0].content[0].text`, with `output_text` also provided
for convenience. `codex` means the configured Codex default; use `/v1/models`
to discover explicit model names available to the logged-in account.

For streaming:

```bash
curl -N "$BRIDGE_URL/v1/responses" \
  -H "Authorization: Bearer $BRIDGE_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"model":"codex","input":"Explain binary search briefly.","stream":true}'
```

Chat Completions is also available:

```bash
curl -N "$BRIDGE_URL/v1/chat/completions" \
  -H "Authorization: Bearer $BRIDGE_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"model":"codex","messages":[{"role":"user","content":"Hello"}],"stream":true}'
```

## Supported API subset

All endpoints require `Authorization: Bearer <gateway-token>`.

| Endpoint | Behavior |
| --- | --- |
| `GET /healthz` | HTTP liveness and number of active requests; no backend call |
| `GET /readyz` | Starts Codex and verifies ChatGPT login; does not run inference |
| `GET /v1/models` | Reads the Codex model catalog plus the local `codex` alias |
| `POST /v1/responses` | Text, function tools, instructions, reasoning effort, JSON or SSE |
| `POST /v1/chat/completions` | Text/tool messages, reasoning effort, JSON or SSE |

- Responses accepts a string `input` or an array of text messages with `role`
  and `content`. Text parts may use `input_text`, `output_text`, or `text`.
- Chat Completions accepts `messages` and optional `reasoning_effort`.
  Responses uses `reasoning: {"effort":"..."}`. Accepted effort values depend
  on the selected Codex model.
- `system` and `developer` messages become Codex developer instructions.
  Conversation history is serialized into the new user turn. This is an
  approximation of role-based chat, not exact OpenAI message semantics.
- New conversations use an ephemeral thread and separate app-server process.
  Tool-result requests resume the waiting native turn. `previous_response_id`
  is supported for a pending tool response only. For new user turns, send the
  full history; completed responses are not stored. Only `store:false` is accepted.
- Client-defined function tools are supported in both API formats, including
  streaming and tool-result continuation. See [Tool calling](TOOL_CALLING.md)
  for runnable examples, supported tool choices, and continuation rules.
- Responses SSE sends lifecycle events, text deltas, and `response.completed`.
  Chat SSE sends completion chunks and `[DONE]`, with optional
  `stream_options: {"include_usage":true}`. Usage comes from Codex, including
  its harness overhead; unavailable usage is `null`.
- Errors before streaming use HTTP status codes and an `error` object. Errors
  after streaming begins use `response.failed` or a Chat SSE error object.
- Images, file attachments, output token caps, built-in
  OpenAI tools, strict function-schema mode, and structured output are unsupported.
  Valid Chat Completions sampling controls are accepted as no-ops. Other unsupported parameters return HTTP 400. `metadata` is echoed locally.

## Copilot / IDE integration

Text chat and client function calling are implemented. **Actual IntelliJ
Copilot integration has not been verified.** An IDE that lets you configure an
OpenAI-compatible provider would use:

| Setting | Value |
| --- | --- |
| Base URL | `http://<intranet-ip>:8765/v1` |
| API key | Your gateway token |
| Model | `codex` or an ID from `/v1/models` |

The client must support a custom endpoint, bearer authentication, and this API
subset. A client requiring a full endpoint URL should use `/v1/responses` or
`/v1/chat/completions` directly. Agent mode can submit function tools and execute returned calls on the client.
Other client-specific parameters may still need compatibility work. This service does
not change any separate connectivity requirements the IDE may have.

## Operational behavior

- Defaults: 2 active HTTP backend requests, 8 total Codex sessions (including
  waiting tool turns), a 180-second active-request deadline, a 5-minute tool-result
  deadline, a 1 MiB request limit, 8 MiB generated output per response, and
  15-second SSE heartbeats. Set `BRIDGE_MAX_SESSIONS` and
  `BRIDGE_TOOL_TIMEOUT_MS` to adjust the waiting-turn limits.
- Excess requests get 429 with `Retry-After`. Disconnects during generation,
  timeouts, and service shutdown terminate the affected subprocess. Successful
  tool-call responses retain it until the client replies or the tool deadline
  expires. Temporary working directories
  are removed afterward. OS-level forced termination may leave temporary files.
- The bridge forces the OpenAI provider, removes inherited API-key environment
  variables, and refuses accounts other than ChatGPT. Subscription availability,
  limits, and any account-level extra-usage settings still apply.
- Sessions use an empty temporary working directory, a read-only sandbox, no
  approvals, disabled shell/app/plugin/browser features, and disabled configured
  MCP servers. Codex's code-mode host is enabled because native dynamic-tool
  dispatch requires it; the bridge forwards client tools and never runs their
  implementations. This remains a Codex harness running under the service user's
  identity, **not an OS isolation boundary or a general-purpose model API**.
  Only give the gateway token to trusted clients. A dedicated OS user and Codex
  profile provide stronger separation from your normal development account.
- HTTP carries the token and prompt in cleartext. Bind to your private interface
  and restrict network access to the intended client; use a TLS reverse proxy
  where the intranet transport is not trusted. No CORS access is enabled.
- The service does not log prompts, responses, tokens, or account email.

For persistence, edit `codex-bridge.service.example` with absolute paths, place
it at `~/.config/systemd/user/codex-bridge.service`, and run:

```bash
systemctl --user daemon-reload
systemctl --user enable --now codex-bridge
journalctl --user -u codex-bridge -f
```

The systemd environment file should contain `NAME=value` lines without `export`.
User services need an active user manager; keeping them alive after logout may
require the host administrator to enable lingering for that user.

## Development and verification

```bash
npm test
```

Tests exercise real local HTTP connections and fake JSON-RPC subprocesses:
authentication, validation, model discovery, text responses, both streaming
formats, partial-delta fallback, usage, failures, timeouts, concurrency,
disconnect cancellation, tool-call streaming and continuation, parallel calls,
waiting-session expiry, and temporary-directory cleanup. They do not call
OpenAI or consume subscription usage.

The Docker image pins standalone `@openai/codex` 0.162.1. Its app-server startup
and login requirement have been verified. Container tests use fake backends;
authenticated live inference is not part of CI. The optional
`scripts/smoke-tools.mjs` live test consumes Codex usage. Rerun readiness and
live tool checks after CLI upgrades.

Official protocol and authentication references:
[Codex App Server](https://developers.openai.com/codex/app-server/) and
[Codex authentication](https://developers.openai.com/codex/auth/).

## License

MIT; see [LICENSE](LICENSE).
