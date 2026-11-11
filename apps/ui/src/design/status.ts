// One table drives every status surface: badges, map stations, roster cards, feed icons.
// Class strings are written out in full so Tailwind can see them.
import { BUILTIN_MODELS } from '@/types/colony'
import type { AgentStatus, ModelId, ModelInfo, RoleId, QuestStatus, AlertSeverity } from '@/types/colony'

export interface StatusStyle {
  glyph: string
  label: string
  token: string     // theme color name, e.g. 'st-run' → var(--color-st-run)
  text: string      // text color class
  badge: string     // pill classes (fill 12%, border 40%)
  ring: string      // station border color class
  motion: 'none' | 'breathe' | 'march' | 'attention' | 'shake' | 'flash'
}

export const STATUS: Record<AgentStatus, StatusStyle> = {
  idle:     { glyph: '○', label: 'Idle',            token: 'st-idle', text: 'text-st-idle',    badge: 'text-st-idle bg-st-idle/12 border-st-idle/40',          ring: 'border-st-idle',    motion: 'none' },
  thinking: { glyph: '⋯', label: 'Thinking',        token: 'st-think', text: 'text-st-think',   badge: 'text-st-think bg-st-think/12 border-st-think/40',       ring: 'border-st-think',   motion: 'breathe' },
  running:  { glyph: '›', label: 'Running command', token: 'st-run', text: 'text-st-run',     badge: 'text-st-run bg-st-run/12 border-st-run/40',             ring: 'border-st-run',     motion: 'march' },
  editing:  { glyph: '✎', label: 'Editing files',   token: 'st-run', text: 'text-st-run',     badge: 'text-st-run bg-st-run/12 border-st-run/40',             ring: 'border-st-run',     motion: 'march' },
  waiting:  { glyph: '!', label: 'Waiting on you',  token: 'st-you', text: 'text-st-you',     badge: 'text-st-you bg-st-you/12 border-st-you/40',             ring: 'border-st-you',     motion: 'attention' },
  blocked:  { glyph: '⊘', label: 'Blocked',         token: 'st-blocked', text: 'text-st-blocked', badge: 'text-st-blocked bg-st-blocked/12 border-st-blocked/40', ring: 'border-st-blocked', motion: 'none' },
  error:    { glyph: '✕', label: 'Error',           token: 'st-error', text: 'text-st-error',   badge: 'text-st-error bg-st-error/12 border-st-error/40',       ring: 'border-st-error',   motion: 'shake' },
  paused:   { glyph: '‖', label: 'Paused',          token: 'st-paused', text: 'text-st-paused',  badge: 'text-st-paused bg-st-paused/12 border-st-paused/40',    ring: 'border-st-paused',  motion: 'none' },
  done:     { glyph: '✓', label: 'Done',            token: 'st-done', text: 'text-st-done',    badge: 'text-st-done bg-st-done/12 border-st-done/40',          ring: 'border-st-done',    motion: 'flash' },
  booting:  { glyph: '◌', label: 'Booting',         token: 'st-run', text: 'text-st-run',     badge: 'text-st-run bg-st-run/12 border-st-run/40 border-dashed', ring: 'border-st-run border-dashed', motion: 'breathe' },
}

export const MOTION_CLASS: Record<StatusStyle['motion'], string> = {
  none: '', breathe: 'animate-breathe', march: '', attention: 'animate-attention', shake: 'animate-shake', flash: 'animate-pop',
}

/**
 * Models stay monochrome; tier is shown with pips so they never compete with status color.
 * The registry is open (ModelId is a string): the built-in Claude models are always present,
 * and the store replaces the registry with the snapshot's `models` when live.
 */
let registry: readonly ModelInfo[] = BUILTIN_MODELS

export function setModelRegistry(models: readonly ModelInfo[] | undefined) {
  if (!models?.length) { registry = BUILTIN_MODELS; return }
  // Built-ins first (design order), then any added models.
  const extra = models.filter((m) => !BUILTIN_MODELS.some((b) => b.id === m.id))
  registry = [...BUILTIN_MODELS.map((b) => models.find((m) => m.id === b.id) ?? b), ...extra]
}

/** Every model the registry knows, built-ins first. */
export const modelList = (): readonly ModelInfo[] => registry

/** Look up a model; unknown ids get a neutral fallback so nothing crashes on new models. */
export function modelInfo(id: ModelId): ModelInfo {
  const m = registry.find((x) => x.id === id) ?? BUILTIN_MODELS.find((x) => x.id === id)
  if (m) return m
  const short = id.replace(/[^a-z0-9]/gi, '').slice(0, 4).toUpperCase() || '?'
  return { id, provider: 'custom', name: id, short, pips: '◆', power: 3, speed: 3, costEff: 3, cliModel: id, experimental: true }
}

/** Classes get a code + texture, never a hue. */
export const ROLES: Record<RoleId, { code: string; name: string; texture: string }> = {
  orchestrator: { code: 'ORC', name: 'Orchestrator', texture: 'repeating-linear-gradient(45deg,rgb(255 255 255/.05) 0 4px,transparent 4px 8px)' },
  frontend:     { code: 'FE',  name: 'Frontend',     texture: 'repeating-linear-gradient(90deg,rgb(255 255 255/.05) 0 3px,transparent 3px 7px)' },
  backend:      { code: 'BE',  name: 'Backend',      texture: 'repeating-linear-gradient(0deg,rgb(255 255 255/.05) 0 3px,transparent 3px 7px)' },
  qa:           { code: 'QA',  name: 'QA',           texture: 'radial-gradient(rgb(255 255 255/.08) 1px,transparent 1.5px) 0 0/6px 6px' },
  devops:       { code: 'OPS', name: 'DevOps',       texture: 'repeating-linear-gradient(-45deg,rgb(255 255 255/.05) 0 4px,transparent 4px 8px)' },
  researcher:   { code: 'RES', name: 'Researcher',   texture: 'none' },
  custom:       { code: 'CUS', name: 'Custom',       texture: 'linear-gradient(135deg,rgb(255 255 255/.06),transparent)' },
}

export const QUEST_STATUS: Record<QuestStatus, { glyph: string; label: string; text: string }> = {
  backlog:     { glyph: '○', label: 'Backlog',     text: 'text-st-idle' },
  in_progress: { glyph: '›', label: 'In progress', text: 'text-st-run' },
  in_review:   { glyph: '!', label: 'In review',   text: 'text-st-you' },
  blocked:     { glyph: '⊘', label: 'Blocked',     text: 'text-st-blocked' },
  done:        { glyph: '✓', label: 'Done',        text: 'text-st-done' },
  failed:      { glyph: '✕', label: 'Failed',      text: 'text-st-error' },
}

export const ALERT_SEVERITY: Record<AlertSeverity, { toast: boolean; banner: boolean; text: string; border: string }> = {
  critical:  { toast: true,  banner: true,  text: 'text-st-error',   border: 'border-st-error/55' },
  needs_you: { toast: true,  banner: false, text: 'text-st-you',     border: 'border-st-you/45' },
  heads_up:  { toast: false, banner: false, text: 'text-st-blocked', border: 'border-line' },
}

/** HUD meter color by percent used. */
export function meterTone(pct: number, warn = 70, critical = 90) {
  if (pct >= critical) return { bar: 'bg-st-error', text: 'text-st-error', prefix: '✕ ' }
  if (pct >= warn) return { bar: 'bg-st-blocked', text: 'text-st-blocked', prefix: '▲ ' }
  return { bar: 'bg-ink', text: 'text-ink', prefix: '' }
}
