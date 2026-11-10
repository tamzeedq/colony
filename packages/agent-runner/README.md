# @colony/agent-runner

The process that runs inside every `colony-agent` container (`tini -- node /opt/colony/runner.mjs`).
It connects to the control plane over WebSocket, prepares the git workspace and drives one
long-lived `claude -p` (stream-json in and out). It implements docs/phase1.md "Runner behaviour".

```
src/
  main.ts            entry: load env, wire signals, start the Runner
  config.ts          env parsing + validation (all problems reported at once, exit 2)
  connection.ts      WS client: Bearer auth, hello on every connect, outgoing buffer, reconnect/backoff
  workspace.ts       git clone / fetch / branch checkout via git child processes
  claude-process.ts  one `claude -p` child: args, stdin writes, stdout lines, stderr tail, stop/kill
  runner.ts          the state machine: commands, stream mapping, statuses, usage, restarts, shutdown
  test/              fake-claude.mjs, harness.ts (in-process ws control plane, temp git origin)
```

## Environment

| Var | Required | Meaning |
|---|---|---|
| `COLONY_AGENT_ID`, `COLONY_PROJECT_ID` | yes | ids |
| `COLONY_CONTROL_URL` | yes | `ws://` or `wss://` URL of `WS /api/runner` |
| `COLONY_AGENT_TOKEN` | yes | sent as `Authorization: Bearer <token>` |
| `COLONY_GIT_URL` | yes | origin to clone, e.g. `git://git/repo.git` |
| `COLONY_BRANCH` | yes | branch to work on; must not be `main` |
| `COLONY_MODEL` | yes | value for `claude --model` |
| `COLONY_SYSTEM_PROMPT_B64` | yes | base64 role prompt, passed via `--append-system-prompt` (may encode `""`, then the flag is omitted) |
| `CLAUDE_CODE_OAUTH_TOKEN` | yes* | subscription token (*or `ANTHROPIC_API_KEY`). Never logged. |
| `COLONY_SESSION_ID` | no | resume this Claude session on first start |
| `COLONY_MCP_CONFIG_B64` | no | base64 JSON; validated, written to a 0600 temp file, passed via `--mcp-config` |
| `COLONY_WORKSPACE` | no | working tree, default `/workspace` |
| `COLONY_CLAUDE_BIN` | no | CLI binary, default `claude`. A `.js`/`.mjs`/`.cjs` path is run with the current node (used by tests). |
| `COLONY_RESTART_BASE_MS` | no | crash-restart base delay, default 1000 (delays: base, 4×base) |
| `COLONY_SHUTDOWN_GRACE_MS` | no | how long `shutdown` waits after closing stdin, default 30000 |
| `COLONY_INTERRUPT_TIMEOUT_MS` | no | wait for the interrupt `control_response` before SIGINT, default 5000 |

Missing or invalid variables: every problem is printed to stderr and the process exits with code 2.

## Behaviour

1. **Connect.** Sends `hello {agentId, sessionId?, protocol}` first on every (re)connect, then flushes
   messages buffered while disconnected (bounded at 10 000, oldest dropped). Reconnects forever with
   exponential backoff + jitter, 0.5 s to 30 s. After a *re*connect it also restates `workspace` and the
   current `status`, because a restarted control plane may have lost them. Invalid commands are logged and dropped.
2. **Workspace.** Status `booting`. Empty workspace: `git clone`; non-empty without a repo: `git init` +
   `remote add` + `fetch`; existing repo: `origin` is pointed at `COLONY_GIT_URL` and fetched (a failed
   fetch is a warning). Then: local branch → check out (and set upstream if `origin/<branch>` exists);
   only remote → `checkout -b <branch> --track origin/<branch>`; neither → `checkout --no-track -b
   <branch> origin/main`; origin has no `main` yet → the branch starts unborn. Sends `workspace {branch, headSha?}`.
   Setup is retried 6 times (1 s, 2 s, 4 s … backoff; each failure sends a non-fatal `error`), then a
   fatal `error` + status `error`; the runner stays connected so `shutdown` still works.
3. **CLI.** `claude -p --input-format stream-json --output-format stream-json --verbose
   --dangerously-skip-permissions --model <m> [--append-system-prompt <p>] [--resume <id>] [--mcp-config <f>]`
   in the workspace. Status `idle`.
4. **Output.** Each stdout line → `mapClaudeStreamLine` → `event`; `inferAgentStatus` → `status`, sent
   only when it changes (and not while paused). `result` → `result` + `usage`, where `usage.costUsd` is this turn's cost: the sum of
   `model_usage_since_last_result[*].costUSD` when the CLI provides it (2.1.x does), otherwise the delta of the
   cumulative `total_cost_usd`. That total is cumulative per *session* and continues across `--resume`
   (verified: after `set_model` the resumed process reported the old total plus the new turn), so the baseline
   is kept per session id, reset for a new session, and a total that goes down is taken whole (`src/usage.ts`). `rate_limit_event` → `plan_usage`. The session id is taken from
   `system/init` / `result` and used for `--resume` and in later `hello`s.
5. **Commands.**
   - `user_message` → written to stdin; queued while paused, while the CLI is (re)starting, or before the workspace is ready.
   - `interrupt` → stream-json control request (see below); SIGINT if not acknowledged within `COLONY_INTERRUPT_TIMEOUT_MS`.
     A no-op when no turn is in flight. The interrupted turn's error result is reported with status `idle` (event text `Interrupted …`), not `error`.
   - `pause` → status `paused`, interrupt the current turn, hold the queue. Events still flow; statuses don't.
   - `resume` → status `idle`, flush the queue in order.
   - `set_model` → the model id is mapped with `findModel(id).cliModel` (unknown ids are passed through
     as a CLI model name), then the CLI is restarted: interrupt if busy, close stdin, wait ≤10 s, SIGTERM/SIGKILL,
     start again with `--resume <session> --model <new>`. Not reported as an error.
   - `shutdown` → close stdin, wait ≤ `COLONY_SHUTDOWN_GRACE_MS` (an in-flight turn may finish), SIGTERM/SIGKILL, flush the socket, exit 0.
   - **SIGTERM/SIGINT** (Docker stop) → same, but with Docker's 10 s budget in mind: interrupt the turn
     (≤1.5 s), close stdin, wait ≤3 s, then SIGTERM/SIGKILL; exit 0.
6. **Crashes.** Unexpected CLI exit → `error` (with exit code and stderr tail), status `booting`, restart
   with `--resume` after 1 s, then 4 s. The 3rd crash within 5 minutes → fatal `error`, status `error`, no
   more restarts. A later `user_message` or `set_model` counts as a manual retry and starts the CLI again.
   Running commands of the dead process are re-sent as stopped (`running: false`, text `… (stopped)`).
   Messages written to a process that died before emitting `system/init` are re-queued (never lost, never duplicated).
   If `--resume` names a session that doesn't exist in this container (the CLI prints `No conversation found with session ID`
   and exits 1), the runner sends a non-fatal `error`, drops the session id and starts fresh; this is not counted as a crash.

## Interrupt: what the real CLI does (Claude Code 2.1.322, verified in `colony-agent:dev`)

Writing this line to stdin mid-turn works:

```json
{"type":"control_request","request_id":"<id>","request":{"subtype":"interrupt"}}
```

The CLI answers within ~100 ms, then ends the turn:

```json
{"type":"control_response","response":{"subtype":"success","request_id":"<id>","response":{"still_queued":[]}}}
{"type":"user","message":{"content":[{"type":"tool_result","is_error":true,"content":"The user doesn't want to proceed with this tool use. …","tool_use_id":"…"}]}}
{"type":"user","message":{"content":[{"type":"text","text":"[Request interrupted by user for tool use]"}]}}
{"type":"result","subtype":"error_during_execution","is_error":true,"terminal_reason":"aborted_tools","total_cost_usd":…}
```

- A running Bash tool is killed (the 25–40 s `python3 … sleep` never completes); its `tool_result` is an
  error, so the mapper closes the command event with `exitCode: 1`.
- Interrupting between tool calls gives `[Request interrupted by user]` and the same `result` shape.
- The process **stays alive** and the session continues: the next user message is answered normally,
  with the full context. `total_cost_usd` keeps accumulating.
- `system/init` advertises `interrupt_receipt_v1` among its `capabilities`.
- The SIGINT fallback is therefore only for older/broken CLIs; it ends the process, and the runner restarts
  it with `--resume` without reporting a crash.

Other CLI facts the runner relies on: `system/init` is printed at the start of **every** turn (not once per
process) and only after the first user message arrives; `total_cost_usd` is cumulative per session, also across `--resume`;
`result` carries `queued_turn_count` (used to know whether a turn is still in flight).

## Building

```sh
npm run build -w @colony/agent-runner   # → docker/runner/runner.mjs (single ESM file, ~0.9 MB)
```

esbuild bundles `ws`, `zod` and `@colony/shared`. `ws`'s optional native helpers `bufferutil` and
`utf-8-validate` are marked external; `ws` loads them inside `try/catch` and falls back to JS, so the bundle
runs with no `node_modules`. `node docker/runner/runner.mjs` with no env exits 2 with the list of missing vars.

## Testing

```sh
npm run typecheck -w @colony/agent-runner
npm test -w @colony/agent-runner
```

Tests start the real runner (`node --import tsx src/main.ts`) against an in-process `ws` control plane,
a temporary bare git origin and `src/test/fake-claude.mjs`, which emits stream-json shaped like the real CLI
(including the interrupt sequence above and the `--resume` failure) and logs its argv and stdin to a file.
They cover boot (hello/auth/workspace/flags), a turn (events, statuses without repeats, result, per-turn usage,
plan usage), the recorded fixture, pause/queue/resume, `set_model` (`--resume` + mapped model), crash restart,
the 3-crash give-up, unknown session fallback, SIGINT fallback, reconnect, `shutdown`, and an empty origin.
SIGTERM can't be delivered as a catchable signal on Windows, so it was verified with `docker stop` (below).

### Real CLI, end to end (manual)

No host bind mounts: copy the bundle in with `docker create` + `docker cp` + `docker start`.

```sh
docker volume create e2e-repo   # seed a bare repo at /repo/repo.git (chown 1000) with a helper container
docker create --name e2e-agent -e CLAUDE_CODE_OAUTH_TOKEN -e COLONY_AGENT_ID=… … \
  -e COLONY_CONTROL_URL=ws://host.docker.internal:7799/api/runner \
  -e COLONY_GIT_URL=file:///repo/repo.git -v e2e-repo:/repo colony-agent:dev node /tmp/runner.mjs
docker cp docker/runner/runner.mjs e2e-agent:/tmp/runner.mjs && docker start e2e-agent
```

with a small `ws` server on the host port 7799 acting as the control plane.

Results (2026-11, Claude Code 2.1.322, Docker Desktop on Windows): hello/workspace/idle, a Write + Bash
turn (events, statuses, result, usage, plan_usage), interrupt of a 40 s foreground command (result 63 ms
after the command), `set_model` → `--resume` on haiku with context kept, `shutdown` (exit 0), `docker stop`
mid-command (interrupt acked, container exit 0 in 1.1 s), and the unknown-`COLONY_SESSION_ID` fallback.

**host.docker.internal reachability:** from a container, `host.docker.internal` (192.168.65.254) reached
host servers bound to `0.0.0.0` **and** to `127.0.0.1` (HTTP round trip to both). Docker Desktop delivers
these connections to the host loopback, so the control plane can bind `127.0.0.1` (not exposed on the LAN).
