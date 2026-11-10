# Colony agent image: one container per agent.
# Runs as the non-root `node` user (uid 1000) so Claude Code's
# --dangerously-skip-permissions is allowed and the host stays protected.
FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates curl jq ripgrep tini \
      python3 python3-pip python3-venv make g++ \
    && rm -rf /var/lib/apt/lists/*

# Claude Code CLI (headless runtime for every agent)
RUN npm install -g @anthropic-ai/claude-code && npm cache clean --force

USER node
WORKDIR /workspace
RUN git config --global user.name "Colony Agent" \
 && git config --global user.email "agent@colony.local" \
 && git config --global init.defaultBranch main

# Agent runner (bundled from packages/agent-runner: `npm run build -w @colony/agent-runner`)
COPY --chown=root:root runner/runner.mjs /opt/colony/runner.mjs

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "/opt/colony/runner.mjs"]
