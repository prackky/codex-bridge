FROM node:22-bookworm-slim
ARG CODEX_VERSION=0.162.1
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global @openai/codex@${CODEX_VERSION} \
    && npm cache clean --force
WORKDIR /app
COPY --chown=node:node package.json *.mjs ./
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node .env.example ./
RUN mkdir -p /home/node/.codex && chown node:node /home/node/.codex \
    && printf 'cli_auth_credentials_store = "file"\n' > /home/node/.codex/config.toml \
    && chown node:node /home/node/.codex/config.toml
ENV CODEX_HOME=/home/node/.codex BRIDGE_HOST=0.0.0.0 BRIDGE_PORT=8765 CODEX_BIN=/usr/local/bin/codex
USER node
EXPOSE 8765
CMD ["node", "server.mjs"]
