# Phase 2: wire the Ops Deck UI to the control plane (working spec)

Contract between the backend additions (apps/control-plane) and the UI data layer (apps/ui). Build against it; report any change you need.

## Auth: pairing, never a proxy that adds the token

Agent containers can reach any port on the host, including loopback-only ones (verified in Phase 1). So nothing on the host may add the admin token to requests on a client's behalf: not the Vite proxy, not a dev endpoint. The **browser** holds the token.

- On start the control plane prints: `Open the Ops Deck: http://localhost:5173/#pair=<adminToken>` (UI origin from `COLONY_UI_URL`, default `http://localhost:5173`).
- The UI reads `#pair=…` once, stores it in `localStorage['colony.adminToken']`, removes the hash with `history.replaceState`, and uses it for all calls.
- Without a stored token, the UI shows a **Pair** screen: paste the token (from `.colony/admin-token`) or open the printed link. A 401 from any call clears the stored token and returns to Pair.
- REST: `Authorization: Bearer <token>`. Stream WS: `/api/stream?token=<token>`. Terminal WS: `/api/agents/:id/terminal?token=<token>&cols=&rows=`.
- Vite dev proxy forwards `/api` (HTTP + WS) to `http://127.0.0.1:7700` **as-is** (no header injection), so the UI is same-origin.

## UI data modes

- **live** (default): data from the control plane only. No mock data, no simulation.
- **mock**: `?mock` in the URL keeps today's mock data + simulation for design work (`?mock&static` freezes it).

## Stream → store

| UiStreamMessage | Store action |
|---|---|
| `snapshot` | `hydrate` (replace projects, agents, quests, alerts, resources, mergeRequests, providers, models, guards; seed feed events) |
| `agent_delta` | `patchAgent` (merge patch) |
| `event` | `emit` to feed listeners (not React state) |
| `alert` | `upsertAlert`; toast if severity critical / needs_you and unresolved |
| `resources` | `resources` |

Snapshot gains `guards` (current Guards) and keeps `events`, `mergeRequests`, `providers`, `models`.

## UI action → API

| UI action | Call |
|---|---|
| pause / resume `{ids}` | `POST /api/agents/:id/pause` / `resume` for each |
| pauseAll | `POST /api/agents/pause-all` |
| kill `{ids}` | `DELETE /api/agents/:id` |
| restart `{id}` | `POST /api/agents/:id/restart` |
| setModel / downshift | `PATCH /api/agents/:id {model}` |
| takeControl `{id}` | `POST /api/agents/:id/take-control` (pause + controller 'you') |
| handBack `{id, note?}` | `POST /api/agents/:id/hand-back {note?}` (controller 'agent', resume, sends a message summarising what you did + `git diff --stat` of the workspace) |
| nudge / composer message | `POST /api/agents/:id/message {text}` |
| resolveAlert | `POST /api/alerts/:id/resolve` |
| spawn | `POST /api/projects/:id/agents {role, model, callsign?, task?, budgetCapUsd?, rolePrompt?}` |
| addProject (Found base) | `POST /api/projects {name, goal, stack, repoUrl?, dailyCapUsd?}`, then for each agent in the chosen team `POST …/agents` |
| setGoal | `PATCH /api/projects/:id {goal}` (server forwards it to the project's orchestrator, if any, as a message) |
| cap | `PATCH /api/projects/:id {dailyCapUsd}` |
| guards | `PATCH /api/guards {…partial Guards}` |
| merge (Review approve) | `POST /api/merge-requests/:id/approve` |
| request changes | `POST /api/merge-requests/:id/request-changes {note}` (status `changes_requested`, message to the requesting agent) |
| quests (questStatus/addQuest) | local only until Phase 3 |

Optimistic local updates are fine; the stream is the source of truth and corrects them.

## New backend endpoints (all admin-token protected)

- `PATCH /api/projects/:id {goal?, dailyCapUsd?}`
- `POST /api/agents/pause-all`
- `POST /api/agents/:id/take-control`, `POST /api/agents/:id/hand-back {note?}`
- `POST /api/merge-requests/:id/request-changes {note}`
- `GET /api/guards`, `PATCH /api/guards` (persisted in kv; guards.ts reads them)
- `GET /api/providers`, `PUT /api/providers/:id {apiKey?, baseUrl?, models?}`, `DELETE /api/providers/:id/key`, `POST /api/providers/:id/test`. Keys are encrypted at rest (AES-256-GCM, key in `<dataDir>/master.key`, created on first use, host only). Responses never include a key: only `hasKey`, a masked hint (`sk-…last4`), status. `claude-subscription` is built in (hasKey = OAuth token present). Using non-Claude providers at runtime (LiteLLM gateway) is a later phase; this phase is storage + test + UI.
- WS `/api/agents/:id/terminal?token=&cols=&rows=`: interactive shell in the agent's container, protocol from `spikes/03-pty` (binary = data both ways, text JSON `{type:'resize',cols,rows}`), exec `bash -l` as `node` in `/workspace`, killed on disconnect (pid-file + SIGHUP/SIGKILL as in the spike), max 3 per agent, idle timeout 30 min, open/close recorded as activity events.

## UI screens to wire

- World, Base, Roster, Inspector, Inbox, Ambient: read from the store (already do).
- Inspector: Live feed (stream + `GET /api/agents/:id/events` backlog), **Terminal** (xterm.js on the terminal WS), **Changes** (`GET /api/projects/:id/diff?branch=<agent.branch>`), Config (model / role prompt / budget → PATCH), controls → API, composer → message (or terminal input in shell take-control mode).
- Spawn, Found base, Settings (limits → guards, alerts local, docker read-only info, **new Providers section** for keys), Review (`/review/:mergeRequestId` from `mergeRequests`, diff from the API, approve / request changes).
- Empty states when there are no projects / agents; `DockerDown` when `resources.host.docker === 'down'`; a "Reconnecting…" banner while the stream is down (retry with backoff).
