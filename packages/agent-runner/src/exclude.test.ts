// Phase 6: the Claude session dir under /workspace/.colony stays out of git.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { excludeColonyDir } from './workspace'

test('excludeColonyDir appends /.colony/ once and keeps existing lines', () => {
  const dir = mkdtempSync(join(tmpdir(), 'colony-ex-'))
  try {
    mkdirSync(join(dir, '.git', 'info'), { recursive: true })
    writeFileSync(join(dir, '.git', 'info', 'exclude'), '# git ls-files --others --exclude-from=.git/info/exclude\n*.log')
    excludeColonyDir(dir)
    excludeColonyDir(dir)
    const text = readFileSync(join(dir, '.git', 'info', 'exclude'), 'utf8')
    assert.equal(text.match(/^\/\.colony\/$/gm)?.length, 1)
    assert.match(text, /^\*\.log$/m)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('excludeColonyDir creates .git/info when missing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'colony-ex-'))
  try {
    mkdirSync(join(dir, '.git'))
    excludeColonyDir(dir)
    assert.match(readFileSync(join(dir, '.git', 'info', 'exclude'), 'utf8'), /^\/\.colony\/$/m)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
