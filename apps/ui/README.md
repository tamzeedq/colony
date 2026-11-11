# Colony · Ops Deck — build handoff

A runnable React + TypeScript + Tailwind v4 app with every Ops Deck screen built on mock data, plus the tokens, types and docs behind it. Screenshots of every screen are in [`SCREENS.md`](SCREENS.md).

```bash
npm run dev        # http://localhost:5173 — live mode: talks to the control plane on :7700 via the /api proxy
                   # ?mock  = design seed data + simulation (sticks for the tab; ?live switches back)
                   # ?mock&static = mock data, simulation frozen
npm run build      # type-check + production build
```

**Live mode (default)** needs the admin token. Open the `http://localhost:5173/#pair=<token>` link the control plane prints, or paste the token from `.colony/admin-token` on the Pair screen. The token lives in `localStorage['colony.adminToken']`; a 401 clears it. The Vite proxy forwards `/api` (HTTP + WebSocket) as-is and never adds the token (docs/phase2.md). Set `COLONY_CONTROL_PLANE_URL` to proxy somewhere other than `http://127.0.0.1:7700`.

Data layer: `src/api/` (`client.ts` REST, `stream.ts` UI stream with backoff, `terminal.ts` agent shell, `endpoints.ts` every route, `token.ts` pairing) and `src/store/` (`reducer.ts` state, `live.ts` action → API mapping, `store.tsx` provider with the mock simulation and the live stream).

## What's inside

| Path | What it is |
|---|---|
| `src/screens/` | One file per screen: `World`, `Base` (switches to the 1920 layout at ≥1800px), `Roster`, `Spawn`, `Inbox`, `NewProject`, `Settings`, `Review`, `Quest`, `Ambient` |
| `src/components/hud/` | `AppShell` (HUD, nav, routes, global overlays), `ResourceHud`, `NeedsYouCounter`, `PlanLimitsPanel` |
| `src/components/agent/` | `AgentCard`; `Inspector` drawer with Take control, Live feed / Terminal / Changes / Task / Config tabs and the composer. It docks beside the content at ≥3000px |
| `src/components/base/` | `BaseMap` (HQ + stations + live link lines, CSS; ready for a Pixi layer), `StationCard`, `QuestBoard`, `QuestCard` |
| `src/components/alerts/` | `AlertItem`, `useAlertAction` (every alert button → action), `ToastStack`, `CriticalBanner` |
| `src/components/feed/` | `ActivityFeed`, `FeedRow`, `FeedIcon` |
| `src/components/states/` | `ShortcutOverlay`, `CommandPalette` (⌘K), `EmptyWorld`, `DockerDown` |
| `src/components/ui/` | Primitives (`StatusBadge`, `ModelBadge`, `RoleTile`, `Meter`, `Button`, `Panel`, `KeyHint`) and controls (`Tabs`, `Segmented`, `Chip`, `Switch`, `Field`, `Bar`, `Segments`) |
| `src/store/` | State + reducer (`reducer.ts`), live action → API mapping (`live.ts`), provider with mock simulation / live stream and selectors (`store.tsx`) |
| `src/data/mock.ts` | Seed data matching the design (4 projects, 16 agents, quests, alerts, usage) |
| `src/hooks/` | `useThrottledStream` (2 Hz, grouping, hover-freeze), `useHotkeys` (the full keyboard map), `useMediaQuery` |
| `src/design/status.ts` | The single status / model / role / alert table every component reads from |
| `src/types/colony.ts` | Domain model |
| `tokens/` | `tokens.json` (source of truth), `theme.css` (Tailwind v4 `@theme`, imported by `src/index.css`), `tailwind.config.ts` (v3 equivalent, not used by the app) |
| `screenshots/` | 24 PNGs of the running app at 1440, 1920, 3440 and in ambient mode |
| `COMPONENTS.md` | Component inventory, real-time rules, Pixi notes, keyboard, motion, sound, accessibility, backend assumptions |

## Routes

| Route | Screen |
|---|---|
| `/` | World |
| `/base/:key` | Project base (1–9) |
| `/roster` | Roster |
| `/spawn?project=1` | Spawn agent |
| `/inbox` | Inbox |
| `/new` | Found new base |
| `/settings/:section` | Settings: `limits` `alerts` `providers` `docker` `teams` `roles` `keys` |
| `/review/:id` | Merge review (merge request id or PR number; mock: `/review/48`) |
| `/quest/q-api` | Quest detail |
| `/ambient` | Ambient wall mode (W) |
| `/states` | Empty and error states |

The Inspector opens over any route; click any agent.

## What's mocked

- **All data and actions.** Pause, kill, restart, take control, merge, spawn and found-base update local state only.
- **Plan usage.** The usage numbers are invented. Check what your Claude plan actually exposes and how often it can be read. If nothing is readable, set `usage.source` to `'unavailable'` and the limit panel hides.
- **Terminal.** It echoes commands; wire it to a PTY in the agent's container.
- **Sound.** Only the mute toggle exists; audio playback isn't built.
- **Base map.** CSS lines; swap in PixiJS for pulses, pan and zoom.

## Naming

- Background colours: `hud`, `well`, `ground`, `surface`, `raised`.
- Borders: `line-soft`, `line`, `line-strong`.
- Text: `ink`, `ink-soft`, `ink-muted`, `ink-dim`.
- Status colours: `st-idle`, `st-think`, `st-run`, `st-you`, `st-blocked`, `st-error`, `st-paused`, `st-done`, used with opacity like `bg-st-run/12`.
- Amber `you` is reserved for actions that act as you.

## Suggested next steps

1. Replace `src/data/mock.ts` and the simulation in `store.tsx` with your backend: Docker API, agent session streams, git.
2. Wire Take control to really pause the agent loop after the current tool call, and connect the Terminal tab to a PTY.
3. Add the PixiJS layer to `BaseMap`.
4. Add sound (`useSound`) per Settings → Alerts.
