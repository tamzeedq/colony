# Colony: iteration plan (after v1)

Written 2026-11-23, after Phases 0–6 and two rounds of commander feedback (19 items) landed on `main`. Colony works day to day, with real bases, approvals, Supabase stacks, restarts and PRs back to GitHub. The next work should make it **trustworthy without watching it**, **smooth to come back to and move between bases**, **cheaper to run**, **better at planning**, and **reachable away from the desk**.

The plan of record stays `docs/execution-plan.md`. This document is the backlog it pulls from. Each iteration is about one to two weeks part-time, ships on its own branch, and ends with a real run on one base.

## How we work

- **Iterate from real use.** Every iteration starts by reading the commander's local notes (`docs/feedback.md`, never committed) and folding them in first.
- **Verify, don't trust:**
  - every change gets tests;
  - UI changes get a browser check;
  - infra changes get a real-Docker check;
  - agent-behaviour changes get one real run on Haiku.
- **Mind usage.** Subagents use Haiku or Sonnet unless the work is genuinely hard; keep parallel agents few. Real-agent runs use the smallest model that can do them.
- **Hard rules don't move:**
  - no host mounts or Docker socket in agent containers;
  - no merge to `main` without a recorded human approval;
  - no secrets in git.

---

## Iteration 1: Prove it and keep it healthy (reliability)

**Progress (2026-11-23, branch `iteration-1`):**
- **Done:**
  - CI workflow (typecheck, unit tests, UI build, LF check, Playwright e2e; a Docker job on manual trigger)
  - 9 Playwright smoke tests (Inbox, HUD pause, roster, quest page, settings), passing
  - Claude Code pinned (2.1.330), with "restart outdated agents"
  - dead Spawn options removed ("Merge without approval" gone)
  - real Level/XP progression
  - demo-mode banner, and "Demo only, not sent" for actions taken on demo data
  - "N merged commits not on GitHub" indicator
  - `npm start` opens the Ops Deck
  - base-map links stay aligned on large screens; pausing shown on the map
- **Verified for real:**
  - `npm run stop`: control plane, UI, Supabase and Colony containers stopped; other stacks untouched
  - keep-awake on and off: helper starts and exits
  - Docker Desktop auto-start (it exposed a Docker Desktop stale-socket bug, fixed by hand)
  - paused agents now stay paused across restarts, and Resume restarts their container
- **Left:**
  - the scripted real-agent check (`npm run e2e:agents`)
  - GitHub publish with a real token
  - `gen_types` against the real CLI
  - SCREENS regen in CI
  - splitting the largest files
  - the CI run on GitHub itself, which happens on push


*Why:* several features are built and unit-tested but have never run for real, and the repo has no CI. A regression today is only found by the commander.

1. **CI for the Colony repo** (GitHub Actions on push and PR):
   - typecheck, control-plane, shared and runner tests;
   - UI build;
   - the shell-script and LF checks.

   Docker integration tests run on a manual trigger.
2. **UI tests.** Today there are none. Add Playwright smoke tests against mock mode for the flows that broke or were added recently:
   - Inbox dismiss, confirm and Undo;
   - Pause all countdown and Resume;
   - roster card opens the Inspector;
   - quest page Review button;
   - Settings saves.

   Run them in CI.
3. **Scripted real-agent check (`npm run e2e:agents`).** One throwaway base and a tiny goal, on Haiku workers with a Sonnet orchestrator. It asserts the full loop:
   - plan, staff, complete;
   - QA verification (#11);
   - team check-in (#8);
   - merge request;
   - a forced merge conflict, followed by a fix quest.

   A human approves (the script waits on the Inbox). Run before each release, and record usage cost.
4. **Close the "not tried for real" list:**
   - GitHub publish with a real token;
   - Shut down Colony and `npm run stop` on a running Colony;
   - the keep-awake helpers on Windows;
   - `gen_types` against the real CLI.
5. **Pin and upgrade Claude Code deliberately.** The agent image installs `@anthropic-ai/claude-code` unpinned. Pin the version, and add a "new Claude Code available" check plus an `npm run agent:image` reminder. Show the image or CLI version per agent.
6. **Stale agents after upgrades.** Agents keep their old prompts, env and image until restarted. Show a "restart to update" badge on agents whose prompt, env or image predates the current build, with a one-click **Restart outdated agents**.
7. **Honest UI leftovers:**
   - the base map and team strip show "pausing";
   - remove or wire the dead Spawn tool checkboxes. "Merge without approval" must never be offered;
   - implement Level/XP progression, or drop "Level N";
   - regenerate `SCREENS.md` in CI.
8. **Code health:** split the largest files along their seams:
   - `agents.ts` (590 lines): runner protocol vs lifecycle;
   - `docker.ts` (572): agents vs git vs sidecars;
   - `store.ts`, `mcp.ts` (tools per role);
   - `Settings.tsx`: one file per section.

   Refresh `docs/execution-plan.md`, which has stale "not wired" lines.

**Exit:** CI green on every push; one real e2e run passes and is recorded; nothing on the "not tried" list is left.

## Iteration 2: Smooth flow and continuity (sessions, projects, hand-offs)

*Why:* friction showed up between sessions and projects more than inside them.
- Pairings were lost after an app restart, and an approval silently didn't register in an unpaired tab.
- Merged work piled up unpublished (20 and 29 commits) until asked.
- Starting and stopping took several manual steps.
- After time away, there was no "where was I?".

### Picking up where you left off
1. **"Since you were away" briefing** on opening the Ops Deck (and per base): what merged, what's waiting on you, which agents finished, failed or are stuck, spend since the last visit. One click to each item. Stored per device as "last seen".
2. **Resume where you left off.** `npm start` (and the desktop app) remembers what was running at shutdown: agents, paused-by-you vs paused-by-limits, Supabase stacks. It offers "Resume as before" vs "Start everything paused". The shutdown summary from `npm run stop` is shown at the next start.
3. **Goal history and next-goal queue per base.** Every goal is kept with its outcome (quests, merges, spend, retro). The commander can queue the next goal, so the orchestrator moves on when one finishes instead of idling until you return.

### Pairing and devices
4. **Pairing that survives restarts.** Pair once per browser and device, and let it outlive app restarts and storage resets: device sessions with refresh, see the security track. `npm start` opens the paired Ops Deck automatically.
5. **An unpaired tab can never fake an action.** In mock or unpaired mode, every action that would act as you (Approve, Answer, Pause) shows a clear "Demo data · not connected" banner and refuses, instead of quietly changing local state.
6. **QR pairing for a phone** from Settings (ties to Iteration 5, Reach).

### Moving between projects
7. **A global switcher and search.** The command palette (⌘K) finds any base, agent, quest, merge request or alert across all bases, plus recent items and "jump back". Base tabs show a "needs you" count and health at a glance.
8. **Cross-base Inbox and roster filters remembered per device,** with a one-key "next thing that needs me", in any base.
9. **Base templates and cloning.** Found a base from a template (stack preset, roles, Supabase on or off, guards, starting quests), or "clone settings from <base>". Importing a repo detects the stack, scripts and test commands, and pre-fills base memory (Iteration 4, Better plans).
10. **Portable settings.** Export or import Colony config (roles, guards, alert prefs, templates; never secrets) to move to another machine or share a setup.

### Keeping Colony, GitHub and your local checkout in sync
11. **"Not on GitHub yet" indicator per base:** "N merged commits not published · Publish". An optional **Publish after each approved merge** toggle opens or updates a rolling PR, so work never piles up unpublished.
12. **Sync from GitHub.** When a published PR is merged on GitHub, or someone pushes to the repo, Colony notices on start or on a timer. It fast-forwards the base's `main`, or flags divergence and offers a merge quest, so agents always build on what's really upstream.
13. **Hand work back and forth with your own checkout.** Today "Use locally" is fetch-only. Add **Submit a local branch for review**: the commander pushes to a `commander/*` branch (allowed from the host only; `main` stays protected). It shows up in Merge Review like agent work, and the orchestrator can pick it up ("finish this").

### Hand-offs between Claude Code and Colony
14. **"Open this base in Claude Code".** It fetches the base via Use locally, then writes a context file (goal, board, base memory, open merge requests, recent decisions), so a separate Claude Code session starts informed rather than cold.
15. **A `colony` CLI (and MCP server for the commander).** `colony status`, `colony inbox`, `colony quest add "<title>" --base readable`, `colony approve <mr>` (still a recorded human approval), `colony publish <base>`. A Claude Code session or a terminal can then drive Colony without the browser, and status lines and hooks can show "N need you".

### Fewer clicks for routine decisions
16. **Batch review.** Approve several small, verified merges in one pass: each with its summary and acceptance, each recorded as your approval. Similarly, answer several low-stakes agent questions at once.
17. **Remembered answers.** When you answer a recurring question ("use Supabase Storage", "prefer zod"), offer "remember for this base". It goes into base memory, and the orchestrator stops asking.

**Exit:**
- closing and reopening the app (or the machine) loses no pairing and no context;
- switching between two bases takes one keystroke;
- merged work reaches GitHub without being asked;
- a separate Claude Code session can pick up a base with full context.

## Iteration 3: Spend less, see more (cost and control)

*Why:* every agent draws on one subscription, and the commander hit the 5-hour limit while agents and subagents ran in parallel.

1. **Fresher plan usage.** Usage only updates when an agent reports, so it's estimated between reports. Read it on a timer (a cheap periodic probe, or `claude` status if available). Show "as of …" in the HUD, and project when the window runs out.
2. **Usage-aware scheduling:**
   - a per-base "usage budget per hour";
   - queue non-urgent quests when the window is tight;
   - run QA verification and team checks on Haiku;
   - automatic downshift that actually changes worker models at the threshold, not only the setting.
3. **Escalate on failure.** Start workers on Haiku where the orchestrator allows. If a quest fails verification twice, retry it on Sonnet, with the reason recorded. Teach the orchestrator this rule and track the outcome in analytics.
4. **Cost per quest and per goal.** Attribute spend and tokens to quests (via `currentTaskId` at usage time). Show it on the quest page and in Spend & usage, along with "most expensive quests this week".
5. **Context hygiene.** Show context % trends. Auto-suggest "restart with a fresh context and a summary" when an agent passes ~80%. Give orchestrators a `summarize_and_restart` path that keeps the board.
6. **Idle cost.** Stop idle workers' containers after N minutes, with their workspace kept; idle Supabase already stops. A "free memory" action stops Studio and idle stacks when host RAM is above 90% (ties to feedback #12).

**Exit:** the HUD shows usage at most a few minutes old; one week of analytics shows a measurable drop in usage per merged quest.

## Iteration 4: Better plans and teamwork (orchestration quality)

*Why:* the loop works, but plans are text in an Inbox card, and parallel work collides.

1. **Visual plan approval.** The orchestrator's plan arrives as a board (quests, dependencies, owners, models, estimated cost), not a text question. The commander edits, reorders or cuts quests, then approves. The orchestrator receives the edited plan.
2. **Conflict prediction.** Use each quest's "Owns" paths (structured since feedback #10) to warn when parallel quests overlap, and suggest a dependency. On a real conflict, have a rebase or conflict-fixer worker (Sonnet) rather than only a fix quest.
3. **Base memory.** A per-base `COLONY.md` (or `AGENTS.md`) the orchestrator maintains: stack, commands, conventions, decisions, gotchas. It's injected into every worker's brief, and the commander can edit it in the UI. This cuts re-discovery on every quest.
4. **Retros.** When a goal completes, the orchestrator writes a short retro (what took longest, what failed verification, what to do differently) into base memory, and the commander can comment.
5. **Quest templates.** For common quest types (add endpoint + test, UI screen, migration, dependency bump, security review): brief and acceptance scaffolds with the right `check` defaults.
6. **Smarter team checks.** Include the diff-size trend and test results in the digest. Notice "busy but not converging" (many edits, no passing tests). Escalate to the commander after two nudges, as feedback #8 described.

**Exit:** a multi-quest goal on a real base runs with zero merge conflicts that a human has to resolve, and the plan is approved from the board.

## Iteration 5: Reach (away from the desk)

*Why:* approvals and questions wait while the commander is away; long runs need the machine awake and reachable.

1. **Secure remote access.** Open the Ops Deck from a phone through a tunnel the commander controls (Tailscale, or Cloudflare Tunnel with access rules). The admin token still applies, with short-lived pairing links (ties to the token-rotation work). Never bind 0.0.0.0 by default.
2. **Phone notifications.** Push "needs you" items (approvals, questions, crashes) via a provider the commander chooses (ntfy, Pushover, email). Each links to the item. Quiet hours respected.
3. **Mobile layout pass** for the Inbox, Merge Review (summary, acceptance, Approve) and the HUD. The design already has phone breakpoints for some screens.
4. **Desktop app (Tauri).** One installer, starts with Windows (optional), tray icon with pause/resume, usage and "needs you" count, keep-awake built in. It wraps `npm start`; no new runtime.
5. **Daily digest.** One message or page per day: what merged, what's waiting, spend, anything stuck.

**Exit:** the commander approves a merge and answers a question from a phone, end to end, on a real base.

## Iteration 6: Integrations (beyond Colony's walls)

1. **GitHub two-way:**
   - issues labelled `colony` become quests;
   - PR review comments on published branches flow back to the orchestrator as feedback;
   - CI status from GitHub shows in Merge Review.
2. **Production-safe database flow.** A "promote migrations" step that diffs dev Supabase migrations against a linked project and requires commander approval before `supabase db push` to anything non-local. Agents never get production credentials.
3. **Preview deploys.** Optional per-base deploy hooks (e.g. Vercel or Netlify preview from a published branch), with the link shown in Merge Review.
4. **Other providers, for real.** The LiteLLM gateway route from the original plan, marked experimental, with usage tracked per provider.

## Security track (runs alongside every iteration)

- **Network egress allowlist per base** (package registries, GitHub, Anthropic API), so a compromised dependency can't exfiltrate freely. Start in "log only", then enforce.
- **Scoped secrets vault per base** for real third-party keys agents need (e.g. a Stripe test key). Injected only into roles that need it, redacted everywhere, rotatable.
- **Audit log of commander actions**: approvals, dismissals, rotations, publishes. Searchable, kept 90 days.
- **Signed approvals.** Record approver, time, diff hash and acceptance state for every merge in the merge commit trailer.
- **Expiring pairing links** and per-device sessions instead of one long-lived admin token.

## Suggested order and sizing

| # | Iteration | Size | Depends on |
|---|---|---|---|
| 1 | Prove it and keep it healthy | M | none |
| 2 | Smooth flow and continuity | M–L | 1 (CI and UI tests to protect the flows) |
| 3 | Spend less, see more | M | 1 (e2e harness to measure) |
| 4 | Better plans and teamwork | L | 1; base memory pairs well with 2 |
| 5 | Reach | M | 1, 2 (pairing/devices); the security items for remote access |
| 6 | Integrations | M–L | 1, 2 (GitHub sync), 4 |

**Start with Iteration 1, then 2.** Iteration 1 makes every later change safe to verify. Iteration 2 removes the day-to-day friction (lost pairings, unpublished work, cold starts) that shows up whenever you step away or switch bases. Small pieces of 2 can ride along with 1 if they're cheap: the unpaired-tab guard (#5), the "not on GitHub yet" indicator (#11), and auto-opening the Ops Deck (#4).
