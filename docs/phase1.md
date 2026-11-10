# Phase 1: control plane core (working spec)

This spec is the contract between the three Phase 1 pieces. Build against it; change it only when a piece genuinely needs to, and say so.

## Topology

```
host (Windows)
  control plane  (Node 22, apps/control-plane)  http+ws on COLONY_PORT (default 7700)
     ├─ REST + WS /api/stream   ← UI (apps/ui)
     ├─ WS /api/runner          ← agent-runner in each container (Bearer agent token)
     └─ dockerode ─▶ Docker Desktop

Docker, per project <slug>:
  network   colony-proj-<slug>        (user-defined bridge, has internet)
  git       colony-git-<slug>         container, alias `git` on the project network
            volume colony-git-<slug> mounted at /srv/git, bare repo /srv/git/repo.git
            runs: git daemon --reuseaddr --base-path=/srv/git --export-all --enable=receive-pack /srv/git
            pre-receive hook rejects any push that updates refs/heads/main
  agents    colony-agent-<agentId>    container from colony-agent:dev, on the project network
            volume colony-ws-<agentId> mounted at /workspace (survives restarts)
```

- Agents clone `git://git/repo.git` and push their own branches back. They can never update `main`: the hook rejects it.
- Merging to `main` happens only inside the git container (local git, no hook), called by the control plane after a recorded human approval (`canMergeToMain` in `@colony/shared`).
- No host bind mounts and no Docker socket in any Colony container. Named Docker volumes only.
- Containers reach the control plane at `ws://host.docker.internal:<port>/api/runner`.

## Agent container environment

| Var | Meaning |
|---|---|
| `COLONY_AGENT_ID`, `COLONY_PROJECT_ID` | ids |
| `COLONY_CONTROL_URL` | e.g. `ws://host.docker.internal:7700/api/runner` |
| `COLONY_AGENT_TOKEN` | per-agent random secret, sent as `Authorization: Bearer` on the runner WS |
| `COLONY_GIT_URL` | `git://git/repo.git` |
| `COLONY_BRANCH` | branch to create/use, e.g. `agent/vex-07` |
| `COLONY_MODEL` | value for `claude --model` (registry `cliModel`) |
| `COLONY_SYSTEM_PROMPT_B64` | base64 of the composed role prompt, passed via `--append-system-prompt` |
| `COLONY_SESSION_ID` | optional; resume this Claude session (`--resume`) |
| `COLONY_MCP_CONFIG_B64` | optional; base64 JSON for `--mcp-config` (Phase 3) |
| `CLAUDE_CODE_OAUTH_TOKEN` | subscription token |

Labels on every Colony container/volume/network: `colony=1`, `colony.project=<slug>`, and for agents `colony.agent=<agentId>`.

## Runner (packages/agent-runner) behaviour

1. Connect to `COLONY_CONTROL_URL`; send `hello {agentId, sessionId?, protocol}`. Reconnect with backoff; buffer outgoing messages while disconnected.
2. Workspace: if `/workspace` has no repo, `git clone $COLONY_GIT_URL /workspace`; check out `COLONY_BRANCH` (create from `main` if absent; track remote if it exists). Send `workspace {branch, headSha}`.
3. Start one long-lived `claude -p --input-format stream-json --output-format stream-json --verbose --dangerously-skip-permissions --model $COLONY_MODEL --append-system-prompt <prompt> [--resume <id>] [--mcp-config <file>]` in `/workspace`. Status `idle` until the first `user_message`.
4. Every stdout line → `mapClaudeStreamLine` → `event`; `inferAgentStatus` → `status` when it changes; `parseClaudeResult` → `result` + `usage` (per-turn cost delta from cumulative `total_cost_usd`); `parseRateLimitEvent` → `plan_usage`. Track the session id from `system/init`.
5. Commands: `user_message` → stdin (queued while paused); `interrupt` → stream-json control request `{"type":"control_request","request_id":"…","request":{"subtype":"interrupt"}}` (fallback SIGINT); `pause` → interrupt + hold queue, status `paused`; `resume` → status `idle`, flush queue; `set_model` → restart the CLI with `--resume <session>` and the new model; `shutdown` → close stdin, wait, exit 0.
6. If the CLI exits unexpectedly: send `error`, restart with `--resume`, back off on repeated crashes (after 3 in 5 min: status `error`, stop restarting).

## Control plane (apps/control-plane)

- Node 22 ESM TypeScript run with `tsx`. HTTP: Fastify. WS: `ws` (or `@fastify/websocket`). DB: built-in `node:sqlite` (no native builds) at `.colony/colony.db`.
- `InfraDriver` interface (`src/infra/types.ts`) with the Docker implementation (`src/infra/docker.ts`) and an in-memory fake for tests.
- REST (JSON):
  - `GET  /api/health`, `GET /api/snapshot` (shape = `Snapshot` from `@colony/shared`)
  - `POST /api/projects` `{name, goal?, stack?, repoUrl?}` → creates network + git server + bare repo
  - `DELETE /api/projects/:id` (stops agents, removes containers; volumes kept unless `?purge=1`)
  - `POST /api/projects/:id/agents` `{role, model?, callsign?, task?, budgetCapUsd?}` → spawn
  - `POST /api/agents/:id/message` `{text}` · `/pause` · `/resume` · `/interrupt` · `/restart` · `DELETE /api/agents/:id`
  - `PATCH /api/agents/:id` `{model?, rolePrompt?, budgetCapUsd?}`
  - `GET /api/agents/:id/events?limit=` · `GET /api/projects/:id/branches` · `GET /api/projects/:id/diff?branch=`
  - `POST /api/merge-requests` (internal for now) · `POST /api/merge-requests/:id/approve` → merge via InfraDriver, only if `canMergeToMain`
- WS `/api/stream`: on connect send `snapshot`, then `agent_delta` / `event` / `alert` / `resources`. Check `Origin` is localhost.
- WS `/api/runner`: authenticate Bearer token → agent; route `RunnerMessage`s; keep a map agentId → socket for `RunnerCommand`s.
- Role prompt composition from `roles/`: `_shared.md` + (`orchestrator.md` | `_worker.md` + `<role>.md`), placeholders `{project} {stack} {goal} {orchestrator}`.
- Guards: per-agent `budgetCapUsd` (pause + `budget` alert when reached); plan usage ≥ `pauseWorkersAtPct` (default 90) pauses non-orchestrator agents + alert; warn alert at `warnAtPct` (70).
- On boot: reconcile DB with `listColonyContainers()` (mark missing agents `error`, adopt running ones).
- Container stats polled every 5 s for running agents → `agent_delta`.
