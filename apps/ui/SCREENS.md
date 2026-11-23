# Screens

Captured from the running app in mock data, frozen (`?mock&static`), with headless Chromium at device scale 1, dark colour scheme, full page (Ambient is viewport-sized).

Regenerate the screens that are reachable by URL with `npm run screenshots` from the repo root. That runs `apps/ui/e2e/screenshots.spec.ts` with `COLONY_SCREENSHOTS=1`; the spec is skipped in a normal `npm run test:ui` run. The manual `screenshots` job in `.github/workflows/ci.yml` does the same on CI (Actions > CI > Run workflow, tick `screenshots`) and uploads the `ui-screenshots` artifact. CI never commits the images, so copy them in yourself. CI renders on Linux, so fonts can differ slightly from a local Windows or macOS run.

Interaction-only screens are not regenerated. They need a click or key press to reach, so they are kept from older captures. They still match the layout but don't show the current map canvas controls: Inspector tabs (04–07), after-spawn toast (09), merged review (16), shortcut overlay (18), command palette (19), empty and error states (20), and ultrawide inspector (24).

## World · 1440

Bases as mini-maps, plan limits with pace forecast, needs-you list, colony feed. The critical crash banner is pinned under the HUD.

![World · 1440](screenshots/01-world.png)

## World · 1920

![World · 1920](screenshots/22-world-1920.png)

## Project base · 1440

Goal bar, HQ with stations and live link lines, quest board, activity, infra and branches.

![Project base · 1440](screenshots/02-base-readable.png)

## Project base · 1920

Quest lanes move beside the map; a team strip sits under it.

![Project base · 1920](screenshots/21-base-1920.png)

## Ultrawide · 3440

The inspector docks beside the content instead of covering it.

![Ultrawide · 3440](screenshots/24-ultrawide-docked-inspector.png)

## Roster

Filters by base, class, model and status. Selecting cards shows the bulk bar.

![Roster](screenshots/03-roster.png)

## Inspector · agent in control

Blue strip; Take control is the amber command.

![Inspector · agent in control](screenshots/04-inspect-agent-in-control.png)

## Inspector · you in control

Amber strip, frame and composer; chat or type into its shell.

![Inspector · you in control](screenshots/05-inspect-you-in-control.png)

## Inspector · terminal

![Inspector · terminal](screenshots/06-inspect-terminal.png)

## Inspector · changes

![Inspector · changes](screenshots/07-inspect-changes.png)

## Spawn agent

Class, model stat bars, loadout, optional starting quest, and an option to let the Orchestrator decide.

![Spawn agent](screenshots/08-spawn.png)

## After spawning

The new unit boots at its station, then a toast says it joined.

![After spawning](screenshots/09-spawn-booting-then-joined-toast.png)

## Inbox

Ranked by urgency with inline actions; how each severity reaches you.

![Inbox](screenshots/10-inbox.png)

## Found a new base

![Found a new base](screenshots/11-found-new-base.png)

## Settings · limits & budgets

Guards, pace forecast, auto-downshift, daily caps.

![Settings · limits & budgets](screenshots/12-settings-limits.png)

## Settings · alerts & sound

![Settings · alerts & sound](screenshots/13-settings-alerts.png)

## Settings · role library

![Settings · role library](screenshots/14-settings-role-library.png)

## Merge review

Summary, checks, QA notes, file list, diff with agent notes.

![Merge review](screenshots/15-merge-review.png)

## Merge review · merged

Undo is available for 10 s.

![Merge review · merged](screenshots/16-merge-review-merged.png)

## Quest detail

Dependency graph, brief, acceptance, history, cost.

![Quest detail](screenshots/17-quest-detail.png)

## Ambient wall mode · 1920

Press W. Built to be read from across the room.

![Ambient wall mode · 1920](screenshots/23-ambient-wall-mode.png)

## Shortcut overlay

Press ?.

![Shortcut overlay](screenshots/18-shortcut-overlay.png)

## Command palette

Press ⌘K.

![Command palette](screenshots/19-command-palette.png)

## Empty and error states

No bases yet; Docker down.

![Empty and error states](screenshots/20-empty-and-error-states.png)
