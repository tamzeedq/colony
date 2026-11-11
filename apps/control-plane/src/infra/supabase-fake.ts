// In-memory SupabaseDriver for tests (docs/phase4.md).

import { slotPorts, type SupabaseDriver, type SupabaseMigrationRow, type SupabaseStack, type SupabaseState } from './supabase'

interface FakeStack { running: boolean; slot: number; studio: boolean; migrations: SupabaseMigrationRow[] }

export class FakeSupabase implements SupabaseDriver {
  readonly stacks = new Map<string, FakeStack>()
  readonly calls: string[] = []
  /** Slots whose ports are "taken" by something else on the host. */
  busySlots = new Set<number>()
  /** Make the next start fail with this message. */
  failNextStart?: string
  /** Resolve start only when this promise resolves (lets tests observe 'provisioning'). */
  gate?: Promise<void>

  constructor(private basePort = 55300) {}

  private stack(slug: string, s: FakeStack): SupabaseStack {
    const p = slotPorts(this.basePort, s.slot)
    return { apiPort: p.api, dbPort: p.db, ...(s.studio ? { studioPort: p.studio } : {}), anonKey: 'anon-test-key', serviceRoleKey: 'service-test-key' }
  }

  async start(slug: string, opts: { slot: number; studio: boolean }) {
    this.calls.push(`start ${slug} slot=${opts.slot} studio=${opts.studio}`)
    if (this.gate) await this.gate
    if (this.failNextStart) { const m = this.failNextStart; this.failNextStart = undefined; throw new Error(m) }
    const prev = this.stacks.get(slug)
    const s: FakeStack = { running: true, slot: opts.slot, studio: opts.studio, migrations: prev?.migrations ?? [] }
    this.stacks.set(slug, s)
    return this.stack(slug, s)
  }
  async stop(slug: string, opts: { wipe?: boolean } = {}) {
    this.calls.push(`stop ${slug}${opts.wipe ? ' wipe' : ''}`)
    const s = this.stacks.get(slug)
    if (!s) return
    s.running = false
    if (opts.wipe) s.migrations = []
  }
  async state(slug: string): Promise<SupabaseState> {
    const s = this.stacks.get(slug)
    // The real CLI removes containers on stop, so a stopped stack reads as 'none'.
    return s?.running ? 'running' : 'none'
  }
  async info(slug: string) {
    const s = this.stacks.get(slug)
    return s?.running ? this.stack(slug, s) : null
  }
  async migrations(slug: string) {
    const s = this.stacks.get(slug)
    if (!s?.running) throw new Error('not running')
    return [...s.migrations]
  }
  async genTypes(slug: string) {
    if (!this.stacks.get(slug)?.running) throw new Error('not running')
    return 'export type Database = {}\n'
  }
  async remove(slug: string, opts: { purge?: boolean } = {}) {
    this.calls.push(`remove ${slug}${opts.purge ? ' purge' : ''}`)
    this.stacks.delete(slug)
  }
  async slotFree(slot: number) { return !this.busySlots.has(slot) }
}
