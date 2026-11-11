// Synthesized alert cues (docs/phase5.md "Sound"). No audio files: each cue is a few Web Audio
// oscillators/noise bursts, short (< 600 ms) and quiet, all through one master gain.
//
// Browsers only allow audio after a user gesture, so the single AudioContext is created (or resumed)
// on the first pointerdown/keydown. Until then cues are dropped silently.
import { useCallback, useEffect, useRef } from 'react'
import { useStore, type State } from '@/store/store'
import { getAlertPrefs, inQuietHours, type AlertCategory } from '@/lib/alertPrefs'

type Ctor = typeof AudioContext
let ctx: AudioContext | null = null
let master: GainNode | null = null
let noise: AudioBuffer | null = null

function audioCtor(): Ctor | undefined {
  if (typeof window === 'undefined') return undefined
  return window.AudioContext ?? (window as unknown as { webkitAudioContext?: Ctor }).webkitAudioContext
}

/** Create/resume the context. Only call from inside a user gesture. */
function unlock(): AudioContext | null {
  try {
    if (!ctx) {
      const C = audioCtor()
      if (!C) return null
      ctx = new C()
      master = ctx.createGain()
      master.gain.value = getAlertPrefs().masterVolume
      master.connect(ctx.destination)
    }
    if (ctx.state === 'suspended') void ctx.resume().catch(() => { /* try again on the next gesture */ })
    return ctx
  } catch {
    return null
  }
}

let unlockInstalled = false
function installUnlock() {
  if (unlockInstalled || typeof window === 'undefined') return
  unlockInstalled = true
  const onGesture = () => {
    const c = unlock()
    if (c && c.state === 'running') {
      window.removeEventListener('pointerdown', onGesture, true)
      window.removeEventListener('keydown', onGesture, true)
    }
  }
  window.addEventListener('pointerdown', onGesture, true)
  window.addEventListener('keydown', onGesture, true)
}

function noiseBuffer(c: AudioContext): AudioBuffer {
  if (noise && noise.sampleRate === c.sampleRate) return noise
  const len = Math.floor(c.sampleRate * 0.25)
  noise = c.createBuffer(1, len, c.sampleRate)
  const d = noise.getChannelData(0)
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1
  return noise
}

/** One enveloped oscillator note. */
function tone(c: AudioContext, out: AudioNode, at: number, o: { freq: number; to?: number; type?: OscillatorType; peak: number; attack?: number; decay: number }) {
  const osc = c.createOscillator()
  const g = c.createGain()
  osc.type = o.type ?? 'sine'
  osc.frequency.setValueAtTime(o.freq, at)
  if (o.to) osc.frequency.exponentialRampToValueAtTime(o.to, at + o.decay)
  const a = o.attack ?? 0.005
  g.gain.setValueAtTime(0.0001, at)
  g.gain.exponentialRampToValueAtTime(o.peak, at + a)
  g.gain.exponentialRampToValueAtTime(0.0001, at + a + o.decay)
  osc.connect(g).connect(out)
  osc.start(at)
  osc.stop(at + a + o.decay + 0.02)
}

/** A filtered noise burst (the "body" of a knock, or a tick). */
function burst(c: AudioContext, out: AudioNode, at: number, o: { filter: BiquadFilterType; freq: number; peak: number; decay: number }) {
  const src = c.createBufferSource()
  src.buffer = noiseBuffer(c)
  const f = c.createBiquadFilter()
  f.type = o.filter
  f.frequency.value = o.freq
  const g = c.createGain()
  g.gain.setValueAtTime(0.0001, at)
  g.gain.exponentialRampToValueAtTime(o.peak, at + 0.002)
  g.gain.exponentialRampToValueAtTime(0.0001, at + o.decay)
  src.connect(f).connect(g).connect(out)
  src.start(at)
  src.stop(at + o.decay + 0.02)
}

const CUES: Record<AlertCategory, (c: AudioContext, out: AudioNode, t: number, opts: { levelUp?: boolean }) => void> = {
  // Two low, muted knocks (~350 ms).
  critical: (c, out, t) => {
    for (const dt of [0, 0.19]) {
      tone(c, out, t + dt, { freq: 150, to: 70, peak: 0.5, attack: 0.003, decay: 0.13 })
      burst(c, out, t + dt, { filter: 'lowpass', freq: 420, peak: 0.25, decay: 0.07 })
    }
  },
  // Soft rising two-note chime, E5 → A5 (~480 ms).
  needs_you: (c, out, t) => {
    tone(c, out, t, { freq: 659.25, peak: 0.16, attack: 0.012, decay: 0.3 })
    tone(c, out, t + 0.14, { freq: 880, peak: 0.16, attack: 0.012, decay: 0.32 })
  },
  // Bright two notes C6 → G6, third note C7 on level-up (~400–520 ms).
  quest_complete: (c, out, t, { levelUp }) => {
    tone(c, out, t, { freq: 1046.5, type: 'triangle', peak: 0.13, decay: 0.2 })
    tone(c, out, t + 0.1, { freq: 1568, type: 'triangle', peak: 0.13, decay: 0.26 })
    if (levelUp) tone(c, out, t + 0.22, { freq: 2093, type: 'triangle', peak: 0.11, decay: 0.28 })
  },
  // Quiet tick (~40 ms).
  heads_up: (c, out, t) => {
    burst(c, out, t, { filter: 'highpass', freq: 2500, peak: 0.08, decay: 0.035 })
    tone(c, out, t, { freq: 1800, peak: 0.04, attack: 0.002, decay: 0.03 })
  },
}

/** Play a cue now, ignoring prefs (used by Settings → Test). No-op before the audio unlock. */
export function playCue(cat: AlertCategory, opts: { levelUp?: boolean; gesture?: boolean } = {}) {
  const c = opts.gesture ? unlock() : ctx
  if (!c || !master) return
  const go = () => {
    if (!master || c.state !== 'running') return
    master.gain.setValueAtTime(getAlertPrefs().masterVolume, c.currentTime)
    try { CUES[cat](c, master, c.currentTime + 0.01, opts) } catch { /* audio graph failed: stay silent */ }
  }
  // A fresh context may still be resuming inside the gesture that created it.
  if (c.state !== 'running' && opts.gesture) void c.resume().then(go, () => { /* blocked */ })
  else go()
}

/** Why a cue would be silenced right now (undefined = it plays). */
export function silencedBy(cat: AlertCategory, s: Pick<State, 'agents' | 'ui'>): string | undefined {
  const p = getAlertPrefs()
  if (s.ui.muted) return 'muted'
  if (!p.categories[cat].sound) return 'off'
  if (p.masterVolume <= 0) return 'volume'
  // Critical (crash, host down) cuts through both quiet modes.
  if (cat === 'critical') return undefined
  if (p.quietInTakeControl && s.agents.some((a) => a.controller === 'you')) return 'take-control'
  if (inQuietHours(p)) return 'quiet-hours'
  return undefined
}

/**
 * `play(cat)` plays a cue if prefs, global mute (⇧M), Take control and quiet hours allow it.
 * `test(cat)` plays it regardless (call it from a click: it also unlocks audio).
 */
export function useSound() {
  const { state } = useStore()
  const ref = useRef(state)
  ref.current = state
  useEffect(installUnlock, [])
  const play = useCallback((cat: AlertCategory, opts: { levelUp?: boolean } = {}) => {
    if (silencedBy(cat, ref.current)) return false
    playCue(cat, opts)
    return true
  }, [])
  const test = useCallback((cat: AlertCategory, opts: { levelUp?: boolean } = {}) => playCue(cat, { ...opts, gesture: true }), [])
  return { play, test }
}
