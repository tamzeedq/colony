# Colony — Architecture & Execution Plan

A local app that runs Claude Code agents in Docker containers across multiple projects. Each project gets an Orchestrator agent and a dev Supabase. A game-like UI is used to monitor and control everything.

---

## 1. Architecture at a glance

```
┌──────────────────────────── Your Windows machine ────────────────────────────┐
│                                                                              │
│  Browser ── Colony UI (React + Vite + Tailwind + PixiJS)                     │
│                 │  WebSocket (events)  +  REST (commands)                    │
│                 ▼                                                            │
│  Colony Control Plane  (Node/TypeScript, Fastify, SQLite via Drizzle)        │
│    ├─ Project service    ├─ Agent service    ├─ Task board                   │
│    ├─ Event bus/store    ├─ Budget guard     ├─ Orchestrator MCP tools       │
│    └─ Docker driver (dockerode)  ── talks to Docker Desktop (WSL2) ──┐       │
│                                                                      ▼       │
│  ┌─────── Docker network: colony-<project> ─────────────────────────────┐   │
│  │  [orchestrator]  [worker: frontend]  [worker: backend]  [worker: qa] │   │
│  │   each container = agent-runner + Claude Agent SDK + git worktree    │   │
│  │                                                                      │   │
│  │  [supabase stack: db, auth, rest, storage, studio]  (dev only)       │   │
│  │  [project git volume: bare repo, one worktree per agent]             │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Key decisions

| Area | Decision | Why |
|---|---|---|
| Agent runtime | A small **agent-runner** (TypeScript) inside each container that drives the official **Claude Code CLI in headless mode**: `claude -p --input-format stream-json --output-format stream-json --verbose`, plus `--mcp-config` for Colony's tools and `--resume` for sessions | This is the path that works with your **Claude subscription**, because it runs real Claude Code. It still gives structured events (thoughts, tool calls, edits, usage), lets you inject messages mid-run ("nudge"), pause/resume, and attach custom MCP tools. The runner hides this behind a `Runtime` interface, so an Agent SDK runtime can be added later for API-key agents. |
| "Jump in" | Two modes: **(1) Take control:** pause the SDK loop and chat with the agent as the user turn. **(2) Terminal:** `docker exec` a shell streamed to xterm.js in the UI. You can also launch interactive `claude --resume <session>` in that terminal. | Covers both "steer the agent" and "do it myself". |
| Isolation | Containers run as a non-root user, with CPU/RAM limits, **no host bind mounts**, no Docker socket, and internet egress allowed. Agents run with `bypassPermissions` *inside* the box. | Agents get full freedom while your machine and files stay untouched. |
| Code flow | Each project has a bare git repo in a Docker volume. Each agent gets its **own git worktree + branch**. The Orchestrator (with your approval) merges into `main`. You sync out via `git pull` from Colony or a push to GitHub with a scoped token. | Agents don't trample each other, and your local checkouts are never touched directly. |
| Backend | **One local Supabase stack per project** started by the control plane (Supabase CLI with a unique `project_id` + port range), joined to that project's Docker network. Agents get `SUPABASE_URL`, anon/service keys and `DATABASE_URL` as env vars, plus the Supabase CLI for migrations. | Real Postgres/Auth/Storage with zero cloud cost, safe to wipe. Stacks can be stopped when a project is idle to save RAM. |
| Orchestrator | A long-lived agent with the **Orchestrator** role prompt and an MCP server exposed by the control plane: `create_task`, `spawn_agent`, `assign_task`, `message_agent`, `list_agents`, `get_agent_status`, `review_branch`, `request_merge`, `request_human`, `stop_agent`. | It manages the team through the same API the UI uses, so everything it does shows up in the UI, gets audited, and is subject to budget caps. |
| Workers | Role templates (prompt + default model + tools): Frontend, Backend, QA, DevOps, Researcher, Custom. Workers get a smaller tool set: `report_progress`, `complete_task`, `ask_orchestrator`, `request_human`. | Clear chain of command, and less chaos. |
| Auth (default) | **Your Claude subscription.** Run `claude setup-token` once on the host. Colony stores the token encrypted and injects it as `CLAUDE_CODE_OAUTH_TOKEN` at container start. It is never written to an image or a repo. | Decided: subscription first. All agents share your plan's session and weekly limits, so the Guards (warn %, pause workers %, orchestrator reserve, downshift to Haiku) matter from day one. |
| Other providers | **Settings → Providers** has inputs for extra keys: Anthropic API key, OpenAI, Google, OpenRouter, plus a custom OpenAI-compatible URL. Each agent picks a provider + model in Spawn/Config. Non-Claude models go through a **LiteLLM gateway container** that exposes an Anthropic-compatible endpoint. Those agents get `ANTHROPIC_BASE_URL` pointed at the gateway, so Claude Code drives them unchanged. | One runtime for everything. Caveat: Claude Code's tools and prompts are tuned for Claude, so other models may be weaker at long agentic tasks. Colony labels them "experimental" in the UI. |
| Control-plane DB | SQLite (Drizzle ORM). | Zero-ops for a single-user local tool. Kept separate from the project Supabases on purpose. |
| Realtime | Agent-runner → control plane over WebSocket. The control plane persists events and fans them out to the UI over WebSocket. | One event schema end to end. |

### Normalized event schema (the contract everything hangs on)

```ts
type AgentEvent = {
  id: string; ts: number; projectId: string; agentId: string;
  kind: 'status' | 'thought' | 'text' | 'tool_call' | 'tool_result'
      | 'command' | 'command_output' | 'file_edit' | 'usage'
      | 'message' | 'task_update' | 'alert' | 'error';
  payload: Record<string, unknown>;   // kind-specific
};
type AgentStatus = 'booting' | 'idle' | 'thinking' | 'running_command'
  | 'editing' | 'waiting_human' | 'blocked' | 'paused' | 'error' | 'done';
```

The UI's game layer is just a renderer of `AgentStatus` + events, which keeps the "game" separate from the logic.

---

## 2. Repo layout (monorepo, npm workspaces)

```
colony/
  apps/
    control-plane/        # Fastify API, WS hub, docker driver, orchestrator MCP server
    ui/                   # React app (implements Claude Design output)
  packages/
    agent-runner/         # runs inside containers; wraps Agent SDK
    shared/               # event schema, types, role templates (zod)
  docker/
    agent.Dockerfile      # node, git, gh, supabase CLI, python, common build tools, agent-runner
  roles/                  # orchestrator.md, frontend.md, backend.md, qa.md ...
  docker-compose.dev.yml  # control plane + ui for local dev
```

---

## 3. Phased execution

Each phase ends with something you can actually use. Rough effort assumes you plus Claude Code working together.

### Phase 0 — Spikes ✅ done 2026-11-09
Proved the risky parts before building anything else. Details and results live in `spikes/*/README.md`.
- [x] `colony-agent` image + Claude Code headless (`claude -p` stream-json) on the **subscription token**. Events stream out (`spikes/01-headless`).
- [x] Inject a user message mid-run: picked up within the same run.
- [x] Plan usage is readable: `rate_limit_event` carries 5-hour and 7-day utilization + reset times, so the UI's limit meters can be real (`parseRateLimitEvent` in `@colony/shared`).
- [x] Per-project Supabase with its own `project_id` and a 10-port block per project (base 55300 + 10n), reachable from a project network via `docker network connect` with aliases `supabase-kong` / `supabase-db` (`spikes/02-supabase`). Minimal stack ≈195 MiB, warm start ≈22 s. Pin the CLI version; never log `supabase start` output (it prints keys).
- [x] PTY via `docker exec` (Tty) → WebSocket → xterm.js, with resize, Ctrl-C and shell cleanup on disconnect (`spikes/03-pty`, 11/11 tests).
- [x] `@colony/shared`: domain types, wire protocol, Claude stream → ActivityEvent mapper, tested on a real recording.
- [x] Role prompts in `roles/`.

### Phase 1 — Control plane core ✅ done 2026-11-10
Spec: `docs/phase1.md`. End-to-end check: `spikes/04-e2e/run.mjs` (PASS: project → agent → commit + push → approved merge lands on main → spend recorded → cleanup).
- [x] Data model in `node:sqlite` (`apps/control-plane/src/db.ts`): projects, agents (token hashes), events, alerts, merge_requests, quests, kv, usage_daily.
- [x] Docker driver (`src/infra/docker.ts`): per-project network, locked-down agent containers (non-root, all caps dropped, no-new-privileges, named volumes only), stats, reconcile on boot.
- [x] Git: a per-project **git server container** instead of worktrees. Agents clone/push over `git://git/repo.git`; a pre-receive hook rejects pushes to `main`; merges run inside the git container only after approval.
- [x] Runner (`packages/agent-runner`, baked into `colony-agent:dev`): WS protocol, workspace setup, long-lived `claude -p`, interrupt via stream-json control request, pause/resume, model switch with `--resume`, crash restart.
- [x] REST + WS per `docs/phase1.md`; events persisted and fanned out to UI clients.
- [x] Guards: per-agent budget cap, project daily cap, plan-usage warn (70%) / pause workers (90%). Verified live: real usage at 93% paused a worker.
- [x] **Admin token required** on REST and the UI stream (`.colony/admin-token`, host only). Containers can reach the host even on a loopback-only bind, so the bind address protects nothing; a container calling approve gets 401.

Known gaps carried forward: `contextPct` is always 0 (no honest source yet); guard thresholds are env-only (no Settings route); `resumeAfterReset` and the orchestrator reserve aren't implemented. On Windows, stopping `npm run …` can leave the `tsx` child running; run the control plane with `node --import tsx src/main.ts` when you need to stop it cleanly.

### Phase 2 — Wire the Ops Deck prototype to the backend ✅ built 2026-11-10
Spec: `docs/phase2.md`. The UI runs live by default; `?mock` keeps the design prototype's mock data.
- [x] Live data: REST + `/api/stream` replace mock data and the simulation; reconnect banner; stream is the source of truth over optimistic updates.
- [x] Pairing: the browser holds the admin token (printed `#pair=` link, or paste). Nothing on the host injects it, because containers can reach host ports.
- [x] Every action routed to the API (pause/resume/kill/restart/model/spawn/found base/goal/caps/guards/alerts/merge approve + request changes).
- [x] Take control / hand back (agent gets a git diff summary + your note). Terminal tab = real shell in the container (xterm.js, max 3 per agent, killed on close).
- [x] Settings → Providers: keys encrypted at rest (AES-256-GCM, host-only master key), masked in the UI, test connection. Open model registry.
- [x] Verified against the real backend in the browser: pairing, live World/Base/feed/branches/container stats, real plan limits, Inbox approval, Review with the real diff, reconnect after a control-plane restart (the runner reconnected in ~3 s).
- [x] Base/agent session share now counts only the usage rise between an agent's own reports, not the whole plan.

Not yet click-tested by a human: Approve from the UI, the terminal's visuals, Found base and Spawn forms against the real backend (tested by the UI subagent against a protocol fake). Not wired: Supabase toggle (Phase 4), allowed-tools, "Let Orchestrator decide", quests (Phase 3).

### Phase 3 — Orchestrator & teamwork (≈1–1.5 weeks)
- [ ] Orchestrator MCP server + role prompt: plan → create tasks → spawn/assign workers → review → request merge.
- [ ] Worker tools; inter-agent messaging; task dependencies.
- [ ] Merge flow: Orchestrator runs tests on the branch, opens an "approve merge?" alert, merges on approval, and handles conflicts by assigning a fix task.
- [ ] Guardrails: max concurrent agents per project, loop detection (repeated identical tool calls / no progress for N minutes → alert), spend caps per agent.
**Exit:** give a project a goal and the Orchestrator runs a small team to deliver it, pinging you only for decisions.

### Phase 4 — Dev Supabase per project (≈3–4 days)
- [ ] Provision on project create (toggle), port allocation, start/stop with project activity, wipe/reset button.
- [ ] Inject env vars into agents; install the Supabase MCP server or CLI in agent image for migrations/types.
- [ ] Infra panel: status, Studio link, migrations list.
**Exit:** backend agents build against a real, isolated Postgres/Auth.

### Phase 5 — Game UI polish (≈1 week; screens already exist from the prototype)
- [ ] PixiJS layer in `BaseMap`: handoff pulses, pan/zoom, follow activity.
- [ ] Sound (`useSound`) per Settings → Alerts; desktop notifications.
- [ ] Key-moment animations; regenerate `SCREENS.md` screenshots.
**Exit:** the full game-like command center.

### Phase 6 — Hardening & polish (ongoing)
- [ ] Survive restarts: control plane reconnects to running containers and resumes agent sessions.
- [ ] Snapshots/checkpoints per agent branch; one-click "revert agent's last N commits".
- [ ] GitHub integration: push branches, open PRs from merged work.
- [ ] Cost analytics per project/role/model; recommendations (e.g. "QA agents on Haiku would save X").
- [ ] Optional: package as a desktop app (Tauri), remote access from phone.

**Total to a solid v1:** ~6–8 weeks part-time. Start dogfooding at end of Phase 2 (~2.5 weeks).

---

## 4. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Runaway spend from many parallel agents | Hard per-agent/project/day caps enforced in control plane; default workers to Sonnet/Haiku, Orchestrator on Opus; auto-pause idle agents. |
| Agents stuck in loops or thrashing | Loop detector + "no progress" timer → alert; Orchestrator can restart a worker with fresh context. |
| Merge conflicts between workers | Orchestrator assigns non-overlapping file areas; small tasks; frequent rebases; conflict → fix task. |
| RAM pressure on Windows (many containers + Supabase stacks) | Container limits, stop Supabase for idle projects, cap concurrent agents globally, show host load in HUD. Raise WSL2 memory in `.wslconfig`. |
| Secrets leaking into repos/images | Inject at runtime only; `.gitignore` templates; pre-commit secret scan in agent image. |
| Container escape / host damage | No host mounts, no Docker socket, non-root, dropped capabilities. Agents can still reach the internet, so only give them scoped tokens. |
| Subscription rate limits with many agents | Show usage-limit status in HUD; queue tasks; fall back to API key per project if configured. |

---

## 5. Decisions (settled 2026-11-09)

1. **Name:** Colony.
2. **Billing:** Claude subscription by default (CLI headless runtime). Settings → Providers lets you add other API keys and models. Keys are encrypted at rest in the control-plane DB with a local master key.
3. **Merges to `main`:** always need your approval. The Orchestrator can only *request* a merge, which raises an `approval` alert and opens Merge Review (`/review/:pr`). The Orchestrator has no merge tool; Colony performs the merge itself only after your recorded approval. There is no setting to turn this off in v1.
4. **Colony's own code:** a fresh repo.
5. **Projects Colony manages:** Found Base supports both:
   - **Start fresh:** Colony creates a new empty repo for the project.
   - **Import from GitHub:** Colony clones an existing repo (e.g. Readable) into its own volume. Agents work on that copy. Merged work goes back to GitHub only when you approve a push.

## 6. Design handoff (Claude Design → "Ops Deck")

The handoff is ready to drop in: Tailwind v4 tokens (`theme.css`), the domain model (`types/colony.ts`), a status table, primitives, and a throttled-stream hook. Changes it needs:
- `ModelId` becomes an open string with a model registry (provider, display name, tier pips, power/speed/cost stats), so models from added providers can show up. The four Claude models stay built in.
- Add `provider` to `Agent` and a **Providers** section to Settings (key inputs, test-connection button, models list).
- `PlanUsage`: check what Claude Code exposes headless. If nothing readable, use `source: 'unavailable'` and fall back to spend/token meters, which the design already supports.
- The control plane's event schema maps 1:1 onto the design's `ActivityEvent` kinds (`thought | tool | command | edit | test | message | handoff | status | quest_complete`). Use the design's names everywhere.
- The handoff has no screen images. Phase 5 needs the design canvas (link or exported boards) as the visual reference.

## 7. Immediate next steps

1. Create the `colony` repo (pnpm monorepo) and copy the handoff into `apps/ui`.
2. **Phase 0 spikes:**
   - Run the headless CLI in a container with your subscription token.
   - Inject a message mid-run.
   - Run Supabase on a project network.
   - Attach a PTY to xterm.js.
3. Write the role prompts (`roles/*.md`), starting with the Orchestrator.
