# Colony

Command teams of Claude Code agents across your projects. Each agent runs in its own Docker container on its own git branch. Each project has an Orchestrator agent and a dev Supabase. A game-like "Ops Deck" UI lets you watch, steer, approve and take control.

- Plan: [docs/execution-plan.md](docs/execution-plan.md)
- UI design brief: [docs/design-prompt.md](docs/design-prompt.md)
- UI prototype (mock data): [apps/ui](apps/ui) · screens in [apps/ui/SCREENS.md](apps/ui/SCREENS.md)

## Layout

```
apps/ui              Ops Deck UI (React + Vite + Tailwind v4), currently on mock data
apps/control-plane   API, WebSocket hub, Docker driver, orchestrator MCP tools (Phase 1)
packages/shared      Event schema + domain types shared by UI, control plane, runner
packages/agent-runner  Runs inside each container, drives `claude -p` headless
docker/              agent.Dockerfile
roles/               Role prompts (orchestrator.md, backend.md, ...)
spikes/              Phase 0 throwaway experiments
```

## Getting started

Requires Node 22+ and Docker Desktop (WSL2 backend).

```bash
npm install
npm run dev:ui          # UI prototype at http://localhost:5173
```

Phase 0 headless spike:

```bash
npm run agent:image
docker run --rm -it colony-agent:dev claude setup-token   # copy token into .env
npm run spike:headless
```

## Ground rules

- Agents never touch host files: no bind mounts, no Docker socket, non-root user.
- Merges to `main` always need human approval.
- Default auth is your Claude subscription. Other providers' keys can be added in Settings.
