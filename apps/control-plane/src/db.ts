// SQLite persistence on the built-in node:sqlite (no native builds).
//
// The domain objects are stored mostly as JSON blobs next to the columns we query by; the
// in-memory Store is the source of truth at runtime and writes through to here.

import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import type { DatabaseSync as DatabaseSyncT } from 'node:sqlite'

const require = createRequire(import.meta.url)

/** Load node:sqlite without printing its one-off ExperimentalWarning. */
function loadSqlite(): typeof import('node:sqlite') {
  const orig = process.emitWarning
  process.emitWarning = function (this: unknown, warning: string | Error, ...rest: unknown[]) {
    const msg = typeof warning === 'string' ? warning : warning?.message
    const type = typeof rest[0] === 'string' ? rest[0] : (rest[0] as { type?: string } | undefined)?.type
    if ((type === 'ExperimentalWarning' || (warning as Error)?.name === 'ExperimentalWarning') && /sqlite/i.test(String(msg))) return
    return (orig as (...a: unknown[]) => void).call(process, warning, ...rest)
  } as typeof process.emitWarning
  try {
    return require('node:sqlite') as typeof import('node:sqlite')
  } finally {
    process.emitWarning = orig
  }
}

export const MIGRATIONS: string[] = [
  // 1: initial schema
  `
  CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    key INTEGER NOT NULL,
    data TEXT NOT NULL,             -- Project JSON (stored fields)
    created_at TEXT NOT NULL
  );
  CREATE TABLE agents (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    callsign TEXT NOT NULL,
    token_hash TEXT NOT NULL,       -- sha256(agent token); the token itself is never stored
    session_id TEXT,
    data TEXT NOT NULL,             -- Agent JSON (stored fields)
    internal TEXT NOT NULL,         -- control-plane-only state (queue, desired state, ...)
    created_at TEXT NOT NULL
  );
  CREATE INDEX agents_project ON agents(project_id);
  CREATE UNIQUE INDEX agents_token ON agents(token_hash);
  CREATE TABLE events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    at TEXT NOT NULL,
    json TEXT NOT NULL
  );
  CREATE UNIQUE INDEX events_agent_id ON events(agent_id, id);
  CREATE INDEX events_agent ON events(agent_id, seq);
  CREATE INDEX events_project ON events(project_id, seq);
  CREATE TABLE alerts (
    id TEXT PRIMARY KEY,
    at TEXT NOT NULL,
    project_id TEXT,
    agent_id TEXT,
    resolved_at TEXT,
    json TEXT NOT NULL
  );
  CREATE TABLE merge_requests (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    status TEXT NOT NULL,
    json TEXT NOT NULL
  );
  CREATE TABLE quests (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    json TEXT NOT NULL
  );
  CREATE TABLE usage_daily (
    day TEXT NOT NULL,              -- local YYYY-MM-DD
    agent_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    cost_usd REAL NOT NULL DEFAULT 0,
    tokens INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, agent_id)
  );
  CREATE TABLE kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  // 2: cost analytics (docs/phase6.md §4). Rows written before this read as role/model 'unknown'.
  `
  ALTER TABLE usage_daily ADD COLUMN role TEXT;
  ALTER TABLE usage_daily ADD COLUMN model TEXT;
  ALTER TABLE usage_daily ADD COLUMN quests_done INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE usage_daily ADD COLUMN quests_failed INTEGER NOT NULL DEFAULT 0;
  CREATE INDEX usage_daily_day ON usage_daily(day);
  `,
]

export type Row = Record<string, unknown>

export class Db {
  readonly raw: DatabaseSyncT

  constructor(path: string) {
    const { DatabaseSync } = loadSqlite()
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.raw = new DatabaseSync(path)
    this.raw.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 2000;')
    this.migrate()
  }

  private migrate() {
    const cur = Number((this.raw.prepare('PRAGMA user_version').get() as Row).user_version ?? 0)
    for (let v = cur; v < MIGRATIONS.length; v++) {
      this.raw.exec('BEGIN')
      try {
        this.raw.exec(MIGRATIONS[v])
        this.raw.exec(`PRAGMA user_version = ${v + 1}`)
        this.raw.exec('COMMIT')
      } catch (e) {
        this.raw.exec('ROLLBACK')
        throw e
      }
    }
  }

  all(sql: string, ...params: unknown[]): Row[] {
    return this.raw.prepare(sql).all(...(params as never[])) as Row[]
  }
  get(sql: string, ...params: unknown[]): Row | undefined {
    return this.raw.prepare(sql).get(...(params as never[])) as Row | undefined
  }
  run(sql: string, ...params: unknown[]): void {
    this.raw.prepare(sql).run(...(params as never[]))
  }
  tx<T>(fn: () => T): T {
    this.raw.exec('BEGIN')
    try {
      const r = fn()
      this.raw.exec('COMMIT')
      return r
    } catch (e) {
      this.raw.exec('ROLLBACK')
      throw e
    }
  }

  // ── kv ──
  kvGet<T>(key: string): T | undefined {
    const r = this.get('SELECT value FROM kv WHERE key = ?', key)
    return r ? (JSON.parse(String(r.value)) as T) : undefined
  }
  kvSet(key: string, value: unknown): void {
    this.run('INSERT INTO kv(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value))
  }

  close() {
    try { this.raw.close() } catch { /* already closed */ }
  }
}
