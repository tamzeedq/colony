import { Link } from 'react-router-dom'
import { KeyHint } from '@/components/ui/primitives'

export function EmptyWorld() {
  return (
    <div className="grid min-h-[70vh] place-items-center p-8 text-center">
      <div className="flex flex-col items-center gap-3.5">
        <div className="relative h-24 w-24 bg-line [clip-path:polygon(25%_0,75%_0,100%_50%,75%_100%,25%_100%,0_50%)]">
          <div className="absolute inset-0.5 grid place-items-center bg-ground font-display text-3xl text-ink-dim [clip-path:polygon(25%_0,75%_0,100%_50%,75%_100%,25%_100%,0_50%)]">+</div>
        </div>
        <h1 className="m-0 font-display text-xl font-semibold">Unclaimed territory</h1>
        <p className="m-0 max-w-[280px] text-[13px] leading-normal text-ink-muted">Found your first base: point Colony at a repo and an Orchestrator will plan the work.</p>
        <Link to="/new" className="inline-flex items-center gap-2 rounded-md bg-you px-4 py-2.5 text-[13px] font-bold text-you-ink no-underline">⬢ Found a base <KeyHint>N</KeyHint></Link>
      </div>
    </div>
  )
}

export function DockerDown() {
  return (
    <div className="m-6 overflow-hidden rounded-xl border border-st-error/50 bg-well">
      <div className="bg-st-error px-3.5 py-2 text-xs font-bold text-[#1B0605]">✕ Docker daemon unreachable · all agents frozen</div>
      <div className="flex flex-col gap-3 p-5">
        <h2 className="m-0 font-display text-xl font-semibold">Colony lost its engine room</h2>
        <p className="m-0 text-[13px] leading-relaxed text-ink-muted">Agents are frozen, not lost. Branches and conversation state are saved and resume where they stopped.</p>
        <ol className="m-0 pl-5 text-[13px] leading-[1.8] text-ink-soft"><li>Start Docker Desktop (or <code className="font-mono text-xs">sudo systemctl start docker</code>)</li><li>Colony reconnects on its own every 5 s</li></ol>
      </div>
    </div>
  )
}
