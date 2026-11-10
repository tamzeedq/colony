import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import type { Agent, Project, RoleId } from '@/types/colony'
import { ROLES } from '@/design/status'
import { useStore } from '@/store/store'
import { Switch, Field, inputCls, Segmented } from '@/components/ui/controls'
import { KeyHint } from '@/components/ui/primitives'
import { cx } from '@/lib/util'

const TEAMS: { id: string; name: string; roles: RoleId[]; desc: string }[] = [
  { id: 'solo', name: 'Solo HQ', roles: ['orchestrator'], desc: 'Orchestrator only. Spawns workers when it needs them.' },
  { id: 'trio', name: 'HQ + 2 workers', roles: ['orchestrator', 'frontend', 'backend'], desc: 'Recommended start for a web app.' },
  { id: 'squad', name: 'Full squad', roles: ['orchestrator', 'frontend', 'backend', 'qa', 'devops'], desc: 'Five containers from minute one.' },
]
const STEPS = [
  ['Clone repo into a base volume', 'Each agent gets its own git worktree'], ['Boot the HQ container', 'Orchestrator on Opus 5.5 reads the repo and your brief'],
  ['Provision dev Supabase', 'About 40 s on first run; URL shows in Infra'], ['Orchestrator writes the first quests', 'You approve the plan before workers start'],
  ['Workers spawn and claim quests', 'Frontend + Backend on Sonnet 5.5'],
]

export function NewProject() {
  const { state, dispatch } = useStore()
  const nav = useNavigate()
  const [name, setName] = useState('Pantrybook')
  const [repoMode, setRepoMode] = useState<'github' | 'empty'>('github')
  const [repo, setRepo] = useState('https://github.com/you/pantrybook')
  const [stack, setStack] = useState(['Next.js', 'TypeScript', 'Prisma', 'Tailwind', 'Supabase'])
  const [goal, setGoal] = useState("Meal planner that turns what's in my pantry into a week of dinners. First milestone: pantry inventory with barcode scan, and a \"cook tonight\" suggestion.")
  const [supa, setSupa] = useState(true)
  const [team, setTeam] = useState('trio')
  const key = Math.max(0, ...state.projects.map((p) => p.key)) + 1

  const found = () => {
    const id = `p-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
    const roles = TEAMS.find((t) => t.id === team)!.roles
    const names = ['Hale', 'Moss', 'Kit', 'Arlo', 'Vale']
    const agents: Agent[] = roles.map((r, i) => {
      const aid = `${names[i].toLowerCase()}-${30 + i}`
      return { id: aid, projectId: id, callsign: `${names[i]}-${30 + i}`, role: r, model: r === 'orchestrator' ? 'opus-5.5' : r === 'qa' ? 'haiku-5.5' : 'sonnet-5.5',
        status: 'booting', controller: 'agent', currentAction: 'Booting container…',
        container: { name: `${id.slice(2)}-${aid}`, cpuPct: 4, memMb: 200, memLimitMb: 4096, health: 'ok' },
        contextPct: 0, tokensToday: 0, spendTodayUsd: 0, budgetCapUsd: 8, sessionShare: 0, uptimeSec: 0, level: 1, xp: 0, questsDone: 0, rolePrompt: '', allowedTools: ['read', 'edit', 'bash'] }
    })
    const project: Project = { id, key, name, repoUrl: repoMode === 'github' ? repo : undefined, stack, goal, health: { score: 7, label: 'stable' },
      supabase: { status: supa ? 'provisioning' : 'none' }, orchestratorId: agents[0].id, agentIds: agents.map((a) => a.id),
      spendTodayUsd: 0, dailyCapUsd: 15, sessionShare: 0, unreadAlerts: 0 }
    dispatch({ type: 'addProject', project, agents })
    nav(`/base/${key}`)
  }

  return (
    <div className="flex flex-col">
      <header className="flex flex-wrap items-center gap-4 border-b border-line-soft bg-hud px-7 py-4">
        <Link to="/" className="text-[13px] text-ink-muted no-underline">← World</Link>
        <div><div className="text-label">New project</div><div className="font-display text-[22px] font-semibold">Found a new base</div></div>
        <span className="ml-auto text-xs text-ink-dim">Base slot {key} · key <KeyHint>{key}</KeyHint></span>
      </header>
      <div className="flex flex-wrap">
        <form className="flex min-w-0 max-w-[760px] flex-[1_1_560px] flex-col gap-5 px-8 py-6" onSubmit={(e) => { e.preventDefault(); found() }}>
          <Field label="Base name"><input value={name} onChange={(e) => setName(e.target.value)} className={cx(inputCls, 'font-display text-2xl font-semibold')} /></Field>
          <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
            <legend className="mb-1.5 text-xs text-ink-muted">Repository</legend>
            <Segmented label="Repository source" value={repoMode} onChange={setRepoMode} options={[{ id: 'github', label: 'Connect GitHub repo' }, { id: 'empty', label: 'Start empty repo' }]} />
            {repoMode === 'github' && <>
              <input type="url" value={repo} onChange={(e) => setRepo(e.target.value)} aria-label="GitHub URL" className={cx(inputCls, 'font-mono text-[13px]')} />
              <span className="text-xs text-st-done">✓ Found · default branch main · detected Next.js + Prisma</span>
            </>}
          </fieldset>
          <fieldset className="m-0 border-0 p-0">
            <legend className="mb-2 text-xs text-ink-muted">Stack (auto-detected, edit freely)</legend>
            <div className="flex flex-wrap gap-1.5">
              {['Next.js', 'TypeScript', 'Prisma', 'Tailwind', 'Supabase', 'Playwright'].map((s) => (
                <button key={s} type="button" aria-pressed={stack.includes(s)} onClick={() => setStack((x) => x.includes(s) ? x.filter((y) => y !== s) : [...x, s])}
                  className={cx('rounded-full border px-2.5 py-1.5 text-xs', stack.includes(s) ? 'border-ink bg-ink text-ground' : 'border-line text-ink-soft')}>{s}</button>
              ))}
            </div>
          </fieldset>
          <Field label="Goal brief for the Orchestrator"><textarea rows={4} value={goal} onChange={(e) => setGoal(e.target.value)} className={inputCls} /></Field>
          <div className="flex items-center gap-3.5 rounded-lg border border-line bg-surface p-3.5">
            <Switch on={supa} onChange={setSupa} label="Provision dev Supabase" />
            <div><b className="text-sm">Provision a dev Supabase</b><div className="text-xs text-ink-muted">Local stack in Docker · Postgres, Auth, Storage</div></div>
          </div>
          <fieldset className="m-0 border-0 p-0">
            <legend className="mb-2 text-xs text-ink-muted">Starting team</legend>
            <div className="grid grid-cols-3 gap-2.5">
              {TEAMS.map((t) => (
                <button key={t.id} type="button" aria-pressed={team === t.id} onClick={() => setTeam(t.id)}
                  className={cx('rounded-lg border p-3 text-left', team === t.id ? 'border-you bg-you/8 ring-1 ring-you' : 'border-line bg-surface')}>
                  <b className="block font-display text-[15px] font-semibold">{t.name}</b>
                  <span className="my-2 flex gap-1">{t.roles.map((r, i) => <span key={i} className="grid h-7 w-7 place-items-center rounded-sm border border-line-strong bg-raised font-display text-[9px] font-bold text-ink-soft">{ROLES[r].code}</span>)}</span>
                  <span className="text-xs text-ink-muted">{t.desc}</span>
                </button>
              ))}
            </div>
          </fieldset>
          <div className="flex items-center justify-end gap-2.5">
            <span className="mr-auto text-xs text-ink-dim">Daily cap for this base: <b className="text-ink">$15.00</b> · edit later</span>
            <Link to="/" className="px-3.5 py-2.5 text-[13px] text-ink-muted no-underline">Cancel</Link>
            <button type="submit" className="rounded-lg bg-you px-5.5 py-3 text-[15px] font-bold text-you-ink">⬢ Found {name || 'base'}</button>
          </div>
        </form>
        <aside className="flex min-w-0 flex-[1_1_420px] flex-col gap-4.5 border-l border-line-soft bg-well p-6">
          <div className="text-label">What happens when you found it</div>
          <ol className="m-0 flex list-none flex-col p-0">
            {STEPS.map(([t, d], i) => (
              <li key={t} className="flex items-start gap-3 border-b border-line-soft py-2.5">
                <span className="grid h-[22px] w-[22px] shrink-0 place-items-center rounded-full border border-line-strong font-mono text-[11px] text-ink-muted">{i + 1}</span>
                <div><div className="text-[13px] font-medium">{t}</div><div className="text-xs text-ink-dim">{d}</div></div>
              </li>
            ))}
          </ol>
        </aside>
      </div>
    </div>
  )
}
