# Phase 3: Orchestrator & teamwork

Goal: give a base a goal, and its Orchestrator plans quests, staffs workers, reviews their branches and asks the commander to approve merges. The commander is pinged only for decisions.

## Colony MCP server

The control plane serves MCP at `POST /mcp`: Streamable HTTP, stateless, JSON responses only. There is no SSE stream; `GET` and `DELETE` return 405.

- **Auth:** `Authorization: Bearer <agent token>`, the same token the runner uses, looked up by sha256. `/mcp` is exempt from the admin-token check. An unknown token gets 401.
- **Scope:** the agent's role decides which tools it sees and can call. Every tool acts only inside the agent's own project.
- **Wiring:** `AgentManager.buildEnv` sets `COLONY_MCP_CONFIG_B64` to the config below. The runner passes it to `claude --mcp-config` unchanged. A restart rotates the token, so the config is rebuilt with it.

  ```json
  {"mcpServers":{"colony":{"type":"http","url":"<publicMcpUrl>","headers":{"Authorization":"Bearer <token>"}}}}
  ```

  `publicMcpUrl` defaults to `http://host.docker.internal:<port>/mcp`. `COLONY_PUBLIC_MCP_URL` overrides it.
- **Methods:**
  - `initialize`: echoes the client's `protocolVersion`; capabilities `{ tools: {} }`.
  - `notifications/*`: answered with 202 and no body.
  - `ping`
  - `tools/list`
  - `tools/call`
  - Batches are accepted. Anything else returns `-32601`.
- **Errors:** a tool error is returned as `{ content:[{type:'text',text}], isError:true }` so the model can read it and recover. It is not a JSON-RPC error.

### Orchestrator tools

| Tool | Input | Effect |
|---|---|---|
| `create_task` | `title`, `brief`, `acceptance[]`, `priority?`, `depends_on?[]`, `why?` | New quest, status `backlog`, `createdBy` = orchestrator id. |
| `update_task` | `quest_id`, any of `title`, `brief`, `acceptance[]`, `priority`, `depends_on[]`, `status` (`backlog` \| `failed` \| `done`) | Edit a quest. `done` is for quests that need no merge, such as research. |
| `list_tasks` | `status?` | Quests in this project. |
| `spawn_agent` | `role` (worker roles only), `model?`, `callsign?`, `quest_id?`, `budget_cap_usd?` | Starts a worker. With `quest_id`, the quest is assigned as it boots. |
| `assign_task` | `quest_id`, `agent_id` | Sets the assignee and sends the brief. If dependencies aren't done, the quest goes to `blocked` and is sent automatically once they are. Otherwise it goes to `in_progress`. |
| `message_agent` | `agent_id`, `text` | Delivers `[From <callsign> (orchestrator)] …` and logs a `message` event. |
| `list_agents` | none | Callsign, id, role, model, status, current quest, current action, spend, context. |
| `get_agent_status` | `agent_id` | The above, plus quest details and the last 15 activity events, summarised. |
| `review_branch` | `branch` or `agent_id` or `quest_id` | Commits ahead/behind `main` and the unified diff `main...branch` (clipped to 60 KB), plus how to check it out in your own workspace to run tests. |
| `request_merge` | `quest_id`, `summary`, `branch?` | Opens a MergeRequest (`questId`, `summary`, `requestedBy` = orchestrator) and the approval alert. Refused if the branch is missing or has nothing ahead of `main`. Returns the existing request if one is already pending for that branch. |
| `request_human` | `question`, `options?[]`, `detail?` | A `question` alert (needs you). Each option becomes a `reply:<option>` button. The commander's answer comes back as a message. |
| `stop_agent` | `agent_id` | Removes a worker's container. The volume is kept and the branch stays on the git server. The agent's open quests go back to `backlog`. Refused for itself. |

### Worker tools

| Tool | Input | Effect |
|---|---|---|
| `report_progress` | `text`, `quest_id?`, `acceptance_done?[]` (indices) | A `status` feed event. Ticks acceptance criteria. |
| `complete_task` | `quest_id`, `summary` | Refused unless the quest is assigned to this agent and its branch is on the server with commits ahead of `main`. Sets the quest to `in_review` with `branch` and tells the orchestrator. |
| `ask_orchestrator` | `text` | Delivered to the orchestrator as `[<callsign> asks] …`. If there's no orchestrator, it becomes a `question` alert. |
| `request_human` | as above | as above |

There is no merge tool for anyone. Approval stays an admin-only HTTP call (`canMergeToMain`).

## Quest lifecycle

```
backlog ──assign──▶ in_progress ──complete_task──▶ in_review ──request_merge──▶ (MR pending)
   ▲          └─deps unmet─▶ blocked ──deps done──▶ in_progress
   │                                        approve+merge ──▶ done (+1 questsDone, quest_complete event)
stop_agent / cancel                         request changes ──▶ in_progress (assignee + orchestrator told)
                                            merge conflict  ──▶ orchestrator told to create a fix quest
```

- **Commander quests:** `POST /api/projects/:id/quests {title, brief?, priority?, acceptance?[]}` creates a quest with `createdBy: 'you'`, and the orchestrator is told.
- **Commander edits:** `PATCH /api/quests/:id {status?, title?, brief?, priority?}`.
  - Cancel sets `failed`; the assignee is told to stop and the orchestrator is told.
  - The Review screen's request changes keeps using the merge-request endpoint.
- **Shared types:**
  - `MergeRequest` gains optional `questId` and `summary`.
  - `Quest.branch` is set by `complete_task`.

## Notifications to the orchestrator

Each of these is a `user_message` prefixed `[Colony]`, queued if the orchestrator is offline:

- worker completed a quest
- worker asked a question
- merge merged, changes requested, or conflict/failure
- a blocked quest started
- a worker crashed or was flagged by loop detection

## Kickoff

When an orchestrator is spawned with no task and the project has a goal, its first message is a kickoff. The kickoff asks it to:

1. Read the repo.
2. Create the first quests.
3. Present the plan with `request_human` (options "Approve plan" / "Change it").
4. Wait for the answer before spawning or assigning workers.

This matches Found base's promise: "You approve the plan before workers start." It is enforced by the prompt, not by code.

## Guardrails

- **Agents per project:** at most `COLONY_MAX_AGENTS_PER_PROJECT` live agents (default 5), enforced for both UI and orchestrator spawns. The global container cap still applies.
- **Loop detection:**
  - **Repeats:** the same `command`/`tool`/`edit` signature appearing 6 or more times in an agent's last 12 events raises a `loop` alert (needs you, actions Nudge / Take control / Restart) and tells the orchestrator. It fires at most once per signature per 30 minutes.
  - **Stalls:** an agent that has been busy (`thinking` / `running` / `editing`) with no event for 15 minutes gets a `loop` alert ("no progress"), checked every minute.
- **Budget caps:** per-agent and per-project caps are unchanged from Phase 1.

## UI

- `addQuest` and `questStatus` (cancel, Review's quest moves) call the API in live mode.
- ReviewLive shows the MR's `summary` and its linked quest.
- The quest screens already read `quests` from the snapshot.
