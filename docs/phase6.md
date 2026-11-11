# Phase 6: Hardening

Goal: Colony keeps working through restarts, the commander can undo an agent's work, merged work can go back to GitHub with the commander's approval, and spend is explained. Packaging as a desktop app and remote access stay optional and are out of scope here.

## 1. Survive restarts

- **Sessions on the volume:** agent containers get `CLAUDE_CONFIG_DIR=/workspace/.colony/claude`.
  - The runner adds `.colony/` to `.git/info/exclude` (local only, never committed).
  - A recreated container (restart, token rotation, Docker restart) therefore resumes its Claude session with `--resume` instead of starting fresh.
- **Boot:** for each project, `ensureProject` runs again. It is idempotent, and it starts the git server if it is stopped.
  - Then, for each agent whose container is stopped or missing:
    - **Auto-resume** when `desired = run`, the agent was not already in `error` before the restart, and `COLONY_AUTO_RESUME` is not `0`. Colony restarts it through the normal restart path, which rotates the token, recreates the container on its existing volume and resumes the session. A `heads_up` alert reads "Resumed after restart".
    - Otherwise the current behaviour stays: status `error` plus a crash alert with a Restart action.
- **Docker coming back:** when the stats poller sees Docker go from down to up, reconcile runs again. It is the same function as at boot, and it reconciles the dev Supabase stacks too.

## 2. Checkpoints and revert

Checkpoints are refs in the project's bare repo. Only the agent's own branch changes. `main` is never touched, and the pre-receive hook still protects it.

- **Automatic:** `complete_task` records `refs/colony/checkpoints/<agentId>/<unix-ts>` at the branch head.
- **Manual:** `POST /api/agents/:id/checkpoints` (optional `label`).
- **History:** `GET /api/agents/:id/commits` returns the last 30 commits on the agent's branch, newest first, as `{ sha, subject, at, aheadOfMain, checkpoint?: label }`.
- **Revert:** `POST /api/agents/:id/revert { to: sha } | { count: n }`:
  - **Refused when:**
    - The agent is `running`, `editing` or `thinking`. Pause it first, or send `force: true`.
    - The target is not an ancestor of the branch head.
    - The target is behind the merge-base with `main`.
  - **Steps:**
    1. Save a backup ref `refs/colony/backup/<agentId>/<ts>` at the current head.
    2. Force-update `refs/heads/<branch>` to the target, inside the git container.
    3. If the agent container is running, run `git fetch origin && git reset --hard origin/<branch> && git clean -fd` in it as `node`.
    4. Tell the agent: `[Colony] The commander reverted your branch to <sha>. Your working tree now matches it; re-read files before continuing.`
  - **Response:** `{ from, to, backupRef }`.
  - **Undo:** `POST /api/agents/:id/revert { to: <backup sha> }`. The backup sha is always an allowed target.
- **UI:** the Inspector's Changes tab lists the commits, marks checkpoints, and offers "Revert to here" (with a confirmation that says what is lost) and "Undo last revert".

## 3. GitHub

Merged work goes back to GitHub only when the commander clicks. Agents never see the token.

- **Settings:** Settings → GitHub takes a fine-grained personal access token, stored AES-GCM encrypted with the existing master key (the same box as provider keys).
  - It is entered by the commander in the UI. Colony never logs it or returns it.
  - "Test" calls `GET /user` and shows the login.
- **Per project:** `github: { repo: 'owner/name', base: 'main', mode: 'pr' | 'push' }`, set in the base's Infra panel. A project imported from a GitHub URL is pre-filled from that URL.
- **Publish:** `POST /api/projects/:id/github/publish`:
  - **mode `pr` (default):**
    - Pushes Colony's `main` to `colony/<yyyymmdd-hhmm>` on GitHub.
    - Opens a PR against `base`. The body lists the merged quests and merge requests since the last publish.
    - Returns `{ url, branch }`.
  - **mode `push`:** fast-forward push of Colony's `main` to `base`. It is refused if that would not be a fast-forward.
  - **How the push runs:** inside the git container, as a one-off `git push` with the token passed per command (`-c http.extraHeader=…` via env). It is never written to the repo config.
  - **Afterwards:** an activity event records the result, and the last publish is kept on the project.
- **UI:** a "Publish to GitHub" button in the Infra panel, with status and a link to the PR.

## 4. Cost analytics

- **Storage:** `usage_daily` gains `role` and `model` columns, recorded when usage is written. Old rows read as unknown.
- **API:** `GET /api/analytics?days=7|30` returns:
  - totals and daily series
  - breakdowns by project, role and model (cost, tokens, quests done)
  - `recommendations[]`
- **Recommendations:** simple rules that state their reasoning. For example, a role on Sonnet or Opus with low spend per quest and no failed quests: "QA agents on Haiku would save about $X/week". Savings are estimated with the model registry's relative prices.
- **UI:** a Settings → Spend & usage section with tables, a small daily bar chart and the recommendations.

## Tests

- **Restarts:** the boot sequence with the fake driver: auto-resume versus alert, `ensureProject` rerun, and reconcile on Docker down → up.
- **Checkpoints:** creation, the revert guards, backup and undo, `main` untouched (fake driver, plus a Docker integration test of the git scripts).
- **GitHub:** encryption, publish refusal without a token, mocked fetch for the PR, no token in events or logs.
- **Analytics:** aggregation and the recommendation rules.
