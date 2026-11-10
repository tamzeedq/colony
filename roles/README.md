# Role prompts

These files are the system prompts Colony gives each agent. When the agent-runner starts Claude Code in a container, it assembles the agent's prompt from these files and passes it with `claude --append-system-prompt`, so it sits on top of Claude Code's own system prompt rather than replacing it. Claude Code still brings its normal tools and behaviour; these files add who the agent is, what it is working on, and how it fits into the team.

## How a prompt is assembled

Each agent's prompt is built from layers, joined in this order with a blank line between them:

| Agent | Layers |
|---|---|
| Orchestrator | `_shared.md` + `orchestrator.md` |
| Worker | `_shared.md` + `_worker.md` + `<role>.md` |

- `_shared.md` is the preamble every agent gets: the project and goal, who the commander is, the container environment, git branches and the merge rule, the dev Supabase env vars, the shared budget, and secrets handling.
- `_worker.md` is the protocol common to all workers: the worker tools (`report_progress`, `complete_task`, `ask_orchestrator`, `request_human`), staying in the assigned file area, keeping branches small and rebased, verifying before `complete_task`, and what to do when stuck.
- `<role>.md` holds only what is specific to that role: `frontend.md`, `backend.md`, `qa.md`, `devops.md`, `researcher.md`. `orchestrator.md` stands in for both the worker protocol and a role file, since the Orchestrator has a different tool set and job.

Keeping the shared parts in one place means a change to, say, the budget guidance or the verification rule applies to every role at once, and the role files stay short enough to read and edit comfortably in Settings.

## Variables

The files use placeholders that Colony fills in when it assembles the prompt:

| Variable | Value |
|---|---|
| `{project}` | Project name |
| `{stack}` | The project's stack, comma separated |
| `{goal}` | The project goal the commander wrote (sent to the Orchestrator) |
| `{orchestrator}` | The Orchestrator's callsign, so workers know who to ask |

These match the variables listed in Settings → Role library. An unknown placeholder should be left as is and logged, rather than silently removed.

## Library versus running agents

These files seed the role library. An agent copies its assembled prompt when it is spawned (`Agent.rolePrompt`), so editing a role later, here or in Settings → Role library, affects only agents spawned after the change. To change a running agent's prompt, restart it with its session resumed.

## Adding a custom role

1. Create `roles/<role-id>.md`, using a short lowercase id (for example `mobile.md` or `data.md`).
2. Start with `# Role: <Name>` and a one-paragraph statement of what the role owns and that it works from quests assigned by `{orchestrator}`.
3. Add short sections on the role's conventions, any shared resources it must treat carefully, how it verifies its work before `complete_task`, and what it should ask about rather than decide alone.
4. Do not repeat what `_shared.md` and `_worker.md` already cover; the custom role is layered on top of them like any built-in worker role.

Custom roles created in the UI follow the same layering, with the commander's text standing in for `<role>.md`.

## Writing style

The prompts are written as plain second-person instructions, in prose with short sections, and give the reason behind any rule that is not obvious. Avoid all-caps and stacked emphasis such as "CRITICAL" or "you MUST": current Claude models follow plain instructions closely, and heavy emphasis tends to make them over-apply a rule in situations where it does not fit. Aim for roughly 300 to 600 words per worker role file.
