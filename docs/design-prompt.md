# Prompt for Claude Design — "Colony" (working name)

> Paste everything below the line into Claude Design.

---

## What I'm building

**Colony** is a desktop web app that runs and manages a team of AI coding agents (Claude Code) across several of my software projects at once. Each agent runs in its own Docker container, works on its own git branch, and reports what it's doing live. Every project has one **Orchestrator** agent (the lead) that breaks work into tasks and hands them to **worker** agents (Frontend, Backend, QA, DevOps, Researcher, and so on). I'm the commander. I set goals, watch progress, approve things, and can take control of any agent at any time.

I need a UI that **feels like a strategy or colony-management game** but is still a serious tool I can use for hours. Think of a real-time strategy or base-builder HUD: units at work, a resource bar, alerts that need you, a roster of characters with classes and stats. It should **not** be cartoonish or childish, and it should **not** copy any existing game's art, characters or branding. The game feel should make information easier to read. Every game element maps to real data.

## Who uses it

Just me, a solo developer with many side projects. I usually run 2–5 projects with 2–8 agents each. I glance at it constantly while I do other things, so status has to be readable at a glance from across the room. Then I dive deep when something needs me.

## Core concepts (the data behind the UI)

- **Project**: name, repo, tech stack, goal/brief, health, a dev Supabase backend (status: running/stopped, URL), total spend, active agent count.
- **Agent**: name (auto-generated callsign like "Vex-07", renameable), **role/class** (Orchestrator, Frontend, Backend, QA, DevOps, Researcher, Custom), **model** (Opus 5.5 / Sonnet 5.5 / Haiku 5.5 / Fable 5.1), status (idle, thinking, running command, editing files, waiting on me, blocked, error, paused, done), current task, git branch, container health (CPU/RAM), context window used (%), tokens and $ spent, uptime, tasks done (could be shown as XP/level).
- **Task / Quest**: title, description, assigned agent, status (backlog, in progress, in review, done, failed), linked branch/PR, dependencies. The Orchestrator creates most of them. I can create them too.
- **Activity events**: a live stream per agent of thoughts, tool calls, shell commands + output, file edits (diffs), test results, messages between agents.
- **Alerts / "needs you"**: an agent asks a question, wants approval to merge, hit a budget cap, crashed, or is stuck in a loop.
- **Resources**: global spend today / this month vs. budget, running containers, host CPU/RAM.

## Screens to design

1. **World / Command Overview (home)**
   All projects shown as bases, sectors or islands on a map or grid. Each one shows health, how many agents are active, current activity, and unread alerts at a glance. A persistent top **resource HUD** shows spend vs. budget, running containers, host load, and a global alert counter. Quick actions: new project, pause all, go to an alert.

2. **Project Base view**
   The main working screen for one project. The Orchestrator sits at the center as the "HQ". Worker agents are units at stations around it, animated by status: working, thinking, waiting, error. Lines or pulses show agents messaging each other and tasks being handed off. Side panels hold the Quest board (kanban: backlog → in progress → review → done), a live activity ticker, and an infra panel (container status, Supabase status/URL, git branches and merge state). Somewhere visible there's a "Project goal" input where I give the Orchestrator high-level direction.

3. **Agent Roster / Menu**
   A character-roster screen listing every agent (filterable by project, role, model, status). Each **agent card** shows: portrait/class icon, callsign, role, model badge, status, current task, context bar, spend, level/XP, branch. Bulk actions: pause, resume, kill, reassign. A prominent **"Spawn agent"** button.

4. **Agent Inspect panel** (opens from anywhere when I click an agent)
   - Header: identity, role, model, status, stats.
   - Tabs: **Live feed** (readable stream of thoughts, tool calls, commands), **Terminal** (real shell inside its container), **Changes** (diff of its branch), **Task** (what it's doing and why), **Config** (role prompt / system instructions, model, allowed tools, budget cap).
   - Controls: pause / resume / restart / kill, change model, edit role prompt, send a message or nudge, and a very clear **"Take control"** mode. In that mode I chat with or type into the agent directly while it's paused, then hand control back. Show clearly who is in control: me or the agent.

5. **Spawn Agent flow**
   Set up like character creation or unit recruitment. Pick a class from role templates with short descriptions, pick a model (show trade-offs: power vs. speed vs. cost as stat bars), set name, budget cap, tools/permissions, and optionally a starting task. Include an option to let the Orchestrator decide.

6. **Alerts / Inbox**
   Everything that needs me, ranked by urgency: approvals (merge this branch?), questions from agents, errors, budget warnings. I can respond inline (approve, deny, reply) without leaving the page. Also design how an urgent alert appears over any screen (toast/banner + sound cue note).

7. **New Project setup**
   Name, connect a repo (GitHub URL or empty new repo), stack, goal brief, toggle "provision dev Supabase", and default team composition (e.g. "Orchestrator + 2 workers"). Have it feel like founding a new base.

## Visual direction

- Dark-first, desktop-first (1440px+, also check 1920px and an ultrawide). Must stay legible on long sessions. No neon overload.
- Please explore **2–3 distinct directions**, for example: (a) clean sci-fi tactical HUD, (b) cozy isometric/pixel colony sim, (c) minimal "mission control" with game accents. Then recommend one and take it to high fidelity.
- Strong, consistent **status language** (color + icon + motion) that works for colorblind users. Every status must be readable without relying on color alone.
- Motion: subtle idle animations for working agents, clear "attention" animation for agents waiting on me, satisfying feedback for completed tasks (level-up / quest-complete moment that stays small and doesn't block anything).
- Monospace for logs, terminals and diffs. A distinctive but readable display face for headings.
- Optional ambient sound design notes (task done, alert, error). They should be toggleable.

## Constraints

- Real-time data: design for agents updating many times per second without visual chaos (throttled tickers, grouped events, "X new events" collapse).
- Dense information must stay scannable. Use progressive disclosure: glance → hover → inspect.
- Empty states (no projects, no agents), loading/booting states (container starting, Supabase provisioning), and error states (agent crashed, Docker not running).
- Keyboard shortcuts for power use (e.g. number keys to jump between projects, `Space` to pause the selected agent, `T` to take control). Show a shortcut overlay.
- Will be built in **React + TypeScript + Tailwind**, with a canvas layer (PixiJS or similar) only for the animated base/map view. Keep the component structure implementable.

## Deliverables I want from you

1. 2–3 style exploration frames of the Project Base view, plus a recommendation.
2. High-fidelity designs for all 7 screens in the chosen direction, filled with realistic mock data (e.g. projects "Readable", "Moneo", "FitChecked"; agents like "Vex-07 · Backend · Sonnet 5.5 · running `npm test`").
3. A component sheet: agent card, status badges, model badges, resource HUD, quest card, alert item, activity feed rows (thought / tool call / command / diff / message), buttons, panels, tabs.
4. Design tokens: color (including the status palette), type scale, spacing, radii, elevation, motion durations/easings.
5. Short notes on interactions and animations for the key moments: spawn, take control / hand back, task complete, urgent alert, agent crash.
