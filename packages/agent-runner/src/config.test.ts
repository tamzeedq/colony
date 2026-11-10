import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { ConfigError, loadConfig } from './config'
import { buildClaudeArgs } from './claude-process'
import { PKG_DIR } from './test/harness'

const valid = {
  COLONY_AGENT_ID: 'a1',
  COLONY_PROJECT_ID: 'p1',
  COLONY_CONTROL_URL: 'ws://host.docker.internal:7700/api/runner',
  COLONY_AGENT_TOKEN: 'secret',
  COLONY_GIT_URL: 'git://git/repo.git',
  COLONY_BRANCH: 'agent/vex-07',
  COLONY_MODEL: 'claude-sonnet-5-5',
  COLONY_SYSTEM_PROMPT_B64: Buffer.from('be nice').toString('base64'),
  CLAUDE_CODE_OAUTH_TOKEN: 'tok',
}

test('loadConfig: valid env with defaults', () => {
  const c = loadConfig(valid)
  assert.equal(c.systemPrompt, 'be nice')
  assert.equal(c.workspace, '/workspace')
  assert.equal(c.claudeBin, 'claude')
  assert.equal(c.sessionId, undefined)
  assert.equal(c.restartBaseMs, 1000)
})

test('loadConfig: optional session and MCP config', () => {
  const mcp = JSON.stringify({ mcpServers: {} })
  const c = loadConfig({ ...valid, COLONY_SESSION_ID: 's-1', COLONY_MCP_CONFIG_B64: Buffer.from(mcp).toString('base64') })
  assert.equal(c.sessionId, 's-1')
  assert.equal(c.mcpConfigJson, mcp)
})

test('loadConfig: reports every problem at once', () => {
  try {
    loadConfig({ COLONY_CONTROL_URL: 'http://x', COLONY_BRANCH: 'main', COLONY_MCP_CONFIG_B64: Buffer.from('nope').toString('base64') })
    assert.fail('should throw')
  } catch (e) {
    assert.ok(e instanceof ConfigError)
    const text = e.problems.join('\n')
    for (const needle of ['COLONY_AGENT_ID', 'COLONY_AGENT_TOKEN', 'COLONY_GIT_URL', 'COLONY_MODEL', 'ws:// or wss://', 'non-main branch', 'COLONY_SYSTEM_PROMPT_B64', 'valid JSON', 'CLAUDE_CODE_OAUTH_TOKEN']) {
      assert.ok(text.includes(needle), `missing "${needle}" in:\n${text}`)
    }
  }
})

test('buildClaudeArgs: resume and mcp config', () => {
  assert.deepEqual(buildClaudeArgs({ model: 'm', systemPrompt: '', resume: 's', mcpConfigPath: '/tmp/m.json' }).slice(-5),
    ['m', '--resume', 's', '--mcp-config', '/tmp/m.json'])
})

test('main exits 2 with a readable message when env is missing', () => {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('COLONY_') && k !== 'CLAUDE_CODE_OAUTH_TOKEN' && k !== 'ANTHROPIC_API_KEY') env[k] = v
  const r = spawnSync(process.execPath, ['--import', 'tsx', join(PKG_DIR, 'src', 'main.ts')], { cwd: PKG_DIR, env, encoding: 'utf8', timeout: 20_000 })
  assert.equal(r.status, 2)
  assert.match(r.stderr, /Invalid agent-runner environment/)
  assert.match(r.stderr, /COLONY_AGENT_ID is required/)
})
