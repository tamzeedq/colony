# Colony

Command teams of Claude Code agents across your projects. Each agent runs in its own Docker container on its own git branch. Each project has an Orchestrator agent and a dev Supabase. A game-like "Ops Deck" UI lets you watch, steer, approve and take control.

- Plan: [docs/execution-plan.md](docs/execution-plan.md)
- UI design brief: [docs/design-prompt.md](docs/design-prompt.md)
- Ops Deck UI: [apps/ui](apps/ui) · screens in [apps/ui/SCREENS.md](apps/ui/SCREENS.md) · phase specs in [docs/](docs)

## Layout

```
apps/ui              Ops Deck UI (React + Vite + Tailwind v4, PixiJS base map)
apps/control-plane   API, WebSocket hub, Docker + Supabase drivers, Colony MCP tools
packages/shared      Event schema + domain types shared by UI, control plane, runner
packages/agent-runner  Runs inside each container, drives `claude -p` headless
docker/              agent.Dockerfile
roles/               Role prompts (orchestrator.md, backend.md, ...)
scripts/start.mjs    `npm start` launcher
spikes/              Phase 0 throwaway experiments
```

## Getting started

Requires Node 22+ and Docker Desktop (WSL2 backend).

One-time setup:

```bash
npm install
npm run agent:image                                         # builds colony-agent:dev
docker run --rm -it colony-agent:dev claude setup-token     # put the token in .env as CLAUDE_CODE_OAUTH_TOKEN
```

Run Colony:

```bash
npm start
```

This starts the control plane (port 7700) and the Ops Deck (http://localhost:5173) in one terminal. It checks Docker, the agent image and the token first. The first time, open the "Open the Ops Deck" link it prints, which pairs your browser with the control plane. Ctrl+C stops Colony. Agent containers and dev Supabase stacks keep running, and the next `npm start` reconnects to them.

From the Ops Deck you found a base, give its orchestrator a goal, message or take control of any agent, and approve merges in the Inbox. You don't need the Claude app. Agents use your Claude subscription through the token in `.env`.

Developing Colony itself: `npm run dev:cp` (control plane with reload) and `npm run dev:ui` in two terminals. Use `?mock` in the UI for the design's seed data.

## Ground rules

- Agents never touch host files: no bind mounts, no Docker socket, non-root user.
- Merges to `main` always need human approval.
- Default auth is your Claude subscription. Other providers' keys can be added in Settings.
