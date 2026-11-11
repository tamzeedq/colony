# Phase 5: Game UI polish

Goal: the base map feels alive and the commander hears and sees the moments that matter, without anything becoming noisy. The visual reference is the design handoff in `apps/ui/COMPONENTS.md` ("Base map", "Motion", "Sound") and the tokens in `apps/ui/tokens/theme.css`. No new screens.

## Base map canvas (`components/base/BaseMap.tsx`)

The Pixi layer uses PixiJS v8. It sits under the existing HTML stations, which stay real buttons, crisp and accessible. Both layers share one camera.

- **World:** the existing 960×520 layout (HQ at the centre, workers on an ellipse) defines world coordinates. The HTML overlay gets the same camera transform as the Pixi stage.
- **Pixi draws:**
  - **Grid:** a dot grid replacing the CSS radial background.
  - **Link lines** from HQ to each worker:
    - idle or waiting: a solid `line`
    - live (`running`, `editing`, `thinking`, `booting`): marching dashes in the status colour
  - **Handoff pulses:** a dot travels the link over 1.8 s.
    - `handoff` events go from HQ to `agentId`.
    - `message` events go from `agentId` to `message.to` (either direction along the HQ link, or worker → HQ → worker).
    - Only events newer than mount trigger a pulse.
  - **Spawn ghost:** a dashed outline that pulses where a `booting` station sits.
- **Camera:**
  - Drag to pan and wheel to zoom (0.6×–1.8×, around the cursor).
  - Double-click on empty map, or the "Reset view" button, returns to fit.
  - **Follow activity** (toggle, off by default): eases the camera over 600 ms towards the station with the most events in the last 20 s. Any manual pan or zoom turns it off.
- **Fallback:** with `prefers-reduced-motion` or no WebGL/canvas, the current CSS lines render and pan, zoom and pulses are off. With reduced motion, pulses and dashes are static.
- **Lifecycle:** one Pixi `Application` per mounted map, destroyed on unmount. Pixi reads colours from CSS variables on `:root`, so themes stay in sync. The ticker pauses when the tab is hidden.

## Key moments

- **Spawn:** a new station enters with `animate-pop` (`ease.spring`, 400 ms).
- **Quest complete:** a `quest_complete` event floats a "+N XP" chip up from the agent's station over 900 ms (`celebrate`). If the level rose, the chip reads "Level N".
- **Crash:** a station entering `error` shakes once (`animate-shake`).
- **Urgent alert:** a new critical alert gives the critical banner a single attention flash. Toasts already slide in.
- All of these are skipped under reduced motion. Motion durations come from the tokens.

## Sound (`hooks/useSound.ts`)

Cues are synthesized with Web Audio, with no audio files. Each is short and quiet, and plays through one master gain:

| Category | Triggers | Cue |
|---|---|---|
| critical | alert severity `critical` (crash, host down) | two low muted knocks, repeated once after 60 s if the alert is still unresolved and unseen |
| needs_you | alert severity `needs_you` (approval, question) | soft rising two-note chime |
| quest_complete | `quest_complete` events | bright two notes (third note on level-up), batched within 2 s |
| heads_up | alert severity `heads_up` (loop, budget pace) | quiet tick, off by default |

- **Prefs:** persisted in `localStorage` (`colony.alertPrefs`) and edited in Settings → Alerts & sound. The table checkboxes become real:
  - per category: toast, banner, sound
  - master volume
  - global mute (⇧M, already in the store)
  - quiet while in Take control
  - quiet hours (start and end), during which critical still plays
- **Audio unlock:** the audio context is created on the first user gesture, as browsers require. Before that, cues are dropped silently.
- **What triggers a cue:** only alerts and events that arrive after load. Hydrating the snapshot never plays anything.

## Desktop notifications

- **Opt-in:** a button in Settings → Alerts & sound asks for permission.
- **When they fire:** for critical and needs-you alerts, only while the tab is hidden. The title is the alert title, and the body is the detail plus the base name.
- **Clicking one:** focuses the window and opens Inbox (or Review for an approval).
- **Duplicates:** one notification per alert id.

## Screens

Regenerate the screenshots in `apps/ui/SCREENS.md` that can be reached by URL with headless Edge or Chrome against `?static` mock data. Interaction-only states are kept as they are and marked as such.
