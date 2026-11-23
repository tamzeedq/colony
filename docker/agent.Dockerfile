# Colony agent image: one container per agent.
# Runs as the non-root `node` user (uid 1000) so Claude Code's
# --dangerously-skip-permissions is allowed and the host stays protected.
FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates curl jq ripgrep tini \
      python3 python3-pip python3-venv make g++ postgresql-client \
    && rm -rf /var/lib/apt/lists/*

# Claude Code CLI (headless runtime for every agent)
# Pinned so a rebuild never silently changes agent behaviour. Upgrade deliberately: bump this,
# run `npm run agent:image`, then "Restart outdated agents" in the Ops Deck.
ARG CLAUDE_CODE_VERSION=2.1.330
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} && npm cache clean --force

# Supabase CLI for migrations against the base's dev stack (docs/phase4.md). Same pin as the
# control plane, so local and agent tooling agree.
RUN npm install -g supabase@3.1.0 && npm cache clean --force && supabase --version

# Pre-commit secret scan for every repo (feedback item 6): root-owned, so agents cannot edit it.
COPY --chown=root:root git-hooks/pre-commit /opt/colony/git-hooks/pre-commit
RUN chmod 0755 /opt/colony/git-hooks/pre-commit

USER node
WORKDIR /workspace
RUN git config --global user.name "Colony Agent" \
 && git config --global user.email "agent@colony.local" \
 && git config --global init.defaultBranch main \
 && git config --global core.hooksPath /opt/colony/git-hooks

# Agent runner (bundled from packages/agent-runner: `npm run build -w @colony/agent-runner`)
COPY --chown=root:root runner/runner.mjs /opt/colony/runner.mjs

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "/opt/colony/runner.mjs"]
