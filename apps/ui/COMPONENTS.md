# Colony · Ops Deck — component inventory

Every board on the design canvas, broken into React components. All of these are implemented in `src/` on mock data; screenshots are in `SCREENS.md`. **Bold** items live in `src/components/ui/primitives.tsx`.

## Folder layout

```
src/
  app/                 routes: /, /base/:key, /roster, /inbox, /review/:pr, /quest/:id, /settings/:section, /ambient
  components/
    ui/                primitives: StatusBadge, ModelBadge, RoleTile, Meter, KeyHint, Button, Panel, Tabs, Toast
    hud/               ResourceHud, NeedsYouCounter, ProjectSwitcher, PlanLimitsPanel
    base/              BaseMap (Pixi), StationCard, HqCard, QuestBoard, QuestCard, ActivityFeed, InfraPanel, GoalBar, TeamStrip
    agent/             AgentCard, AgentInspector, ControlBar, LiveFeed, TerminalPane, ChangesPane, TaskPane, ConfigPane, Composer
    feed/              FeedRow (thought | tool | command | edit | test | message | handoff | quest_complete), FeedGroupRow, NewEventsPill
    alerts/            AlertItem, AlertBanner, AlertToastStack, InboxList
    review/            ReviewHeader, CheckList, QaNotes, FileTree, DiffView (unified | split), InlineNote, MergeBar
    quest/             DependencyGraph, AcceptanceList, QuestHistory, QuestCost
    spawn/             ClassPicker, ModelPicker (stat bars), Loadout, RecruitPreview
    project/           FoundBaseForm, TeamTemplatePicker, BootSteps
    settings/          SettingsNav, LimitsSection, AlertsSection, DockerSection, TeamTemplatesSection, RoleLibrarySection, KeyboardSection
    states/            EmptyWorld, EmptyBase, BootingCard, DockerDown, CrashedStation, ShortcutOverlay, CommandPalette
  design/status.ts     the one status/model/role table (glyph + label + color + motion)
  hooks/               useThrottledStream, useHotkeys, useAgent, useProject, usePlanUsage, useSound
  types/colony.ts      domain model
```

## Screen → components

| Board | Route | Main components |
|---|---|---|
| 1 · World | `/` | `ResourceHud`, `NeedsYouCounter`, `BaseTile` ×N (mini-map of stations, health segments, latest action), `PlanLimitsPanel`, `InboxList` (compact), `ActivityFeed` (colony-wide) |
| 2 · Project Base | `/base/:key` | `ProjectSwitcher`, `GoalBar`, `BaseMap`, `QuestBoard` (4 columns), `ActivityFeed`, `InfraPanel` |
| Base · 1920 | same route, ≥1800px | `QuestBoard` as left rail (lanes), `BaseMap`, `TeamStrip`, right rail feed + infra |
| Ultrawide 3440 | same, ≥3000px | icon rail, `BaseTile` list, `BaseMap` with quest lanes overlaid, **docked** `AgentInspector`, `InboxList` |
| Ambient | `/ambient` (W) | `AmbientNeedsYou`, `AmbientRing` ×3, `AmbientBaseTile` ×N, done-ticker |
| 3 · Roster | `/roster` | filter chips, `BulkBar`, `AgentCard` grid |
| 4 · Inspect | drawer over any route (I / click) | `ControlBar` (who's in control), stats strip, `Tabs` → `LiveFeed` / `TerminalPane` / `ChangesPane` / `TaskPane` / `ConfigPane`, `Composer` |
| 5 · Spawn | modal route `/spawn` (S) | `ClassPicker`, `RecruitPreview`, `ModelPicker`, `Loadout`, "Let Orchestrator decide" switch |
| 6 · Inbox | `/inbox` | `InboxList` of `AlertItem`, `AlertBanner`, `AlertToastStack` |
| 7 · Found base | `/new` (N) | `FoundBaseForm`, `TeamTemplatePicker`, `SitePreview`, `BootSteps` |
| 8 · Settings | `/settings/:section` | `SettingsNav` + one section component per item |
| 9 · Merge review | `/review/:pr` | `ReviewHeader`, `CheckList`, `QaNotes`, `FileTree`, `DiffView`, `InlineNote`, `MergeBar` (approve / request changes / undo) |
| 10 · Quest detail | `/quest/:id` | `DependencyGraph`, brief, `AcceptanceList`, `QuestHistory`, assignee card, `QuestCost` |
| States | — | `EmptyWorld`, `EmptyBase`, `BootingCard`, `DockerDown`, `CrashedStation`, `ShortcutOverlay` |

Responsive rule: one route per screen; layout switches at `≥1800px` (1920 layout) and `≥3000px` (ultrawide: inspector docks instead of overlaying, inbox always visible).

## Core components

**`StatusBadge`** `{ status, compact? }` — glyph + label, colour at 12% fill / 40% border. Never render status as colour alone.

**`ModelBadge`** `{ model, compact? }` — monochrome, tier as ◆ pips. `compact` = `SON ◆◆` for map stations.

**`RoleTile`** `{ role, size?, level?, status? }` — class code + texture. With `status` it becomes the map/roster unit: coloured border, glyph corner, motion from the status table.

**`Meter`** `{ label, pct, value, sub?, warn?, critical?, neutral? }` — HUD meter. ≥warn shows `▲` + warm brown, ≥critical shows `✕` + red. Thresholds come from Settings → Guards.

**`Button`** `{ variant: command | primary | secondary | ghost | danger, kbd? }` — `command` (amber) only for actions that act as you: approve, take control, send goal, spawn, found.

**`Panel`** `{ title?, action?, tone: surface | well | raised }`.

`AgentCard` `{ agent, selected, onSelect }` — tile + level chip, callsign, role · project, `StatusBadge`, `ModelBadge`, current task (2 lines), branch, context / spend / XP footer. `waiting` gets the attention ring; `error` gets a red border.

`StationCard` `{ agent }` — compact map unit (190px): code, callsign, compact model, status pill, current action, context bar. Hover → tokens, CPU, uptime. Click → inspector.

`HqCard` `{ orchestrator, questStats }` — larger centre card with violet border.

`QuestCard` `{ quest, assignee }` — title, assignee chip, branch/PR, one note line coloured by quest status. `in_review` gets an amber border.

`AlertItem` `{ alert, onAction }` — severity bar, kind chip (glyph + word), who · where, age, title, optional detail (log tail / question), inline actions. Heads-up kinds render as a single row.

`FeedRow` `{ event }` — 22px icon square by kind + content:
- thought: violet italic
- tool: tool name as a mono chip
- command: terminal block with exit code and duration
- edit: file header + first hunk
- message / handoff: violet-bordered bubble "A → B"
- test: pass/fail counts
- quest_complete: green check + XP

`FeedGroupRow` collapses runs ("Read 6 files ▾").

`ControlBar` `{ controller, onToggle }` — blue "Agent in control" strip or full amber "You have control" strip. The drawer's left border and the composer turn amber too. `T` toggles.

`DiffView` `{ hunks, mode: unified | split, notes }` — line numbers, +/- tint, inline agent notes under lines.

`DependencyGraph` `{ quests, focusId }` — fixed columns by depth, cards placed absolutely, edges drawn as straight lines (marching dashes when the upstream is live). An SVG overlay is fine in the app.

## Real-time

- One WebSocket/SSE stream per window carrying `ActivityEvent`, agent status deltas, alerts and resources.
- `useThrottledStream` buffers events and renders at **2 Hz max**. It collapses same-kind bursts from one agent within 1.5 s, and freezes while hovered or scrolled up, showing "↓ N new events".
- Status changes skip the throttle (they're rare and important). Meters can lerp between values over 240 ms.
- Cap DOM rows (~300 per feed) and virtualise the terminal.

## Base map (canvas)

- PixiJS layer inside `BaseMap`, everything else React.
- Stations are HTML overlays positioned from Pixi world coordinates, so they stay crisp, accessible and clickable. Pixi draws the grid, link lines, marching dashes, handoff pulses (a dot travelling the line over 1.8 s) and the spawn ghost.
- Pan and zoom; "Follow activity" eases the camera to the busiest station.
- Fallback without WebGL or with reduced motion: static CSS lines (`link-live` utility in theme.css).

## Keyboard

| Key | Action |
|---|---|
| 1–9 / 0 | Base / World |
| R | Roster |
| G I / G A | Inbox / next alert |
| S | Spawn |
| N | Found base |
| Q | New quest |
| Space / ⇧ Space | Pause selected / pause everything |
| T | Take control / hand back |
| I or ↵ | Inspect selected |
| M | Nudge |
| ⇧ R | Restart |
| ⇧ ⌫ | Kill (confirm) |
| W | Ambient mode |
| ⌘ K | Command palette |
| ? | Shortcut overlay |
| A / R / E / J / K | Inbox: approve / reply / dismiss / move down / move up |

- Scope keys so they never fire while typing in an input or in Take control.
- Settings → Keyboard rebinding writes to the same map.

## Motion (from tokens)

- Durations: `instant` 80 ms (hover), `fast` 160 ms (toggles, tabs), `base` 240 ms (drawers, toasts), `slow` 400 ms (spawn, take control), `celebrate` 900 ms (XP chip).
- Loops: attention 1.6 s, march 1.4 s, breathe 1.2 s.
- `ease.spring` is used only for level-up and the spawn pop.
- Under `prefers-reduced-motion`, loops stop, the attention ring becomes a static 2px ring, and transitions drop to 80 ms fades.

Key sequences are on the "Key moments" board: spawn, take control / hand back, quest complete, urgent alert, crash.

## Sound (optional, toggleable per category)

| Category | Sound |
|---|---|
| Critical | two low muted knocks, repeated once after 60 s if unseen |
| Needs you | soft rising two-note chime |
| Quest complete | bright two notes (third note on level-up), batched |
| Heads-up | quiet tick, off by default |

- Quiet while in Take control, quiet hours, master volume, global mute ⇧M.
- Use `useSound` with preloaded short WAV/OGG files under ~40 KB each.

## Accessibility checklist

- Status = glyph + word everywhere; colours also differ in lightness.
- Real `<button>`, `<a>`, `<input>`, `<label>`. The roster uses checkboxes for selection. Icon-only buttons get an `aria-label`.
- Toasts use `role="status"`; critical banners use `role="alert"`.
- Meters use `role="meter"` with values.
- Focus ring is a 2px amber outline. All text passes 4.5:1 on its background (the 10–11px dim labels use `ink-dim` #8592A3 on #0E1116 ≈ 5.6:1).

## Backend notes the UI assumes

- **Plan usage (session window, weekly).** The design reads a `PlanUsage` object: used %, reset time, rate. Check what your Claude plan actually exposes and how often it can be read before building on it. If nothing is readable, hide the limit meters and fall back to spend meters (`source: 'unavailable'`).
- **One container per agent**, each with its own git worktree and branch. Container stats come from the Docker API; the event stream comes from each agent's session output.
- **Take control** = pause the agent loop after the current tool call, then route the composer straight to the agent (chat) or to a PTY in the container (shell). On hand back, the agent gets a summary of what you did.
