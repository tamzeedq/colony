// Role prompt composition (roles/README.md):
//   orchestrator: _shared.md + orchestrator.md
//   worker:       _shared.md + _worker.md + <role>.md   (custom: the commander's text instead)
// Placeholders {project} {stack} {goal} {orchestrator}; unknown ones are left as is and logged.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RoleId } from '@colony/shared'

export interface PromptVars {
  project: string
  stack: string[]
  goal: string
  orchestrator?: string
}

const KNOWN = new Set(['project', 'stack', 'goal', 'orchestrator'])

export function fillPlaceholders(text: string, vars: PromptVars, warn: (msg: string) => void = () => {}): string {
  const values: Record<string, string> = {
    project: vars.project,
    stack: vars.stack.join(', ') || 'unspecified',
    goal: vars.goal || '(no goal set yet)',
    orchestrator: vars.orchestrator || 'the Orchestrator',
  }
  return text.replace(/\{([a-z_][a-z0-9_]*)\}/gi, (m, name: string) => {
    if (KNOWN.has(name)) return values[name]
    warn(`unknown placeholder ${m} left as is`)
    return m
  })
}

export class RoleLibrary {
  constructor(readonly dir: string, private warn: (msg: string) => void = (m) => console.warn(`[roles] ${m}`)) {}

  private read(file: string): string | undefined {
    const p = join(this.dir, file)
    return existsSync(p) ? readFileSync(p, 'utf8').trim() : undefined
  }

  /** Assemble the prompt for a role. `customText` stands in for <role>.md (custom roles). */
  compose(role: RoleId, vars: PromptVars, customText?: string): string {
    const layers: string[] = []
    const shared = this.read('_shared.md')
    if (shared) layers.push(shared)
    if (role === 'orchestrator') {
      const o = this.read('orchestrator.md')
      if (o) layers.push(o)
    } else {
      const w = this.read('_worker.md')
      if (w) layers.push(w)
      const roleText = customText?.trim() || (role === 'custom' ? undefined : this.read(`${role}.md`))
      if (roleText) layers.push(roleText)
      else if (role === 'custom') layers.push('# Role: Custom\n\nYou work from quests assigned by {orchestrator}.')
      else this.warn(`missing role file ${role}.md`)
    }
    return fillPlaceholders(layers.join('\n\n'), vars, this.warn) + '\n'
  }
}
