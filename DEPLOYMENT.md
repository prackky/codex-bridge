# Deployment

## Docker

Follow the README quick start. Compose requires version 2.24+ for optional env files.
The image installs the standalone Codex CLI at a stable path and runs as the
unprivileged `node` user. It does not include host credentials or IDE settings.
The volume stores credentials with file-based caching so login survives restarts.

On Linux, the setup container runs as UID 1000. If your checkout has a different
owner, generate the file with `node scripts/setup.mjs` on the host, or use
`docker compose run --rm --no-deps --user "$(id -u):$(id -g)" bridge node scripts/setup.mjs`.

For a port conflict set `BRIDGE_PUBLISHED_PORT=8766` in `.env` before starting.
This runs independently of an existing bridge on port 8765.

For trusted remote clients set `BRIDGE_BIND_ADDRESS=0.0.0.0` in `.env` and
restart with `docker compose up -d`. Use the host address in the client's base URL.
Restrict inbound access to intended clients; use a TLS reverse proxy when the
network is not trusted. Every request requires the gateway token.

The health check tests HTTP liveness. `node scripts/healthcheck.mjs --ready`
inside the container additionally checks that Codex starts and has ChatGPT login.

### Browser login fallback

If device login is unavailable, install Codex locally and complete `codex login`
with file-based credential storage. If `~/.codex/auth.json` exists, import it:

```bash
docker compose run --rm --no-deps -T --entrypoint sh bridge -c 'umask 077; cat > "$CODEX_HOME/auth.json"' < ~/.codex/auth.json
```

This copies the cache into the named volume without adding it to the repository
or image. If your credentials are in an OS keyring, first follow the official
Codex authentication documentation to create a file-based cache. Treat that
file like a password.

### Update

```bash
git pull
docker compose build --pull
docker compose up -d
```

`CODEX_VERSION` is a Docker build argument; change it explicitly to test a new CLI.
The app-server protocol can change between versions. Run `npm test` and a live
readiness/tool smoke check before deploying an upgrade. Pending tool turns do not
survive a restart, so finish them first.

## Linux user service

Use `codex-bridge.service.example`, replace both absolute project paths and the
Node executable, and install it as `~/.config/systemd/user/codex-bridge.service`.
Authenticate Codex as the same user. Set an absolute standalone `CODEX_BIN` in `.env`.

```bash
systemctl --user daemon-reload
systemctl --user enable --now codex-bridge
journalctl --user -u codex-bridge -f
```

## Troubleshooting

- **503 / CODEX_BIN:** run `codex --version` as the service user and verify the path.
- **ChatGPT login required:** sign in using the same `CODEX_HOME`; API-key login is unsupported.
- **429 session limit:** pending client tool results retain slots until their deadline.
  Complete the calls or wait for `BRIDGE_TOOL_TIMEOUT_MS`; adjust `BRIDGE_MAX_SESSIONS`
  if legitimate parallel chats need more capacity. Restarting clears pending turns.
- **410 tool session expired:** start a new chat with full history; do not resend orphaned tool results.

Official setup and authentication references:
https://developers.openai.com/codex/cli/ and https://developers.openai.com/codex/auth/.
