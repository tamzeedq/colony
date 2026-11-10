// Run a command in a container (Tty false), demux stdout/stderr, return the exit code.
import { PassThrough } from 'node:stream'
import type Dockerode from 'dockerode'

export interface ExecResult {
  exitCode: number
  stdout: string
  stderr: string
}

export interface ExecOptions {
  user?: string
  workingDir?: string
  env?: string[]
  /** Kill the stream and reject after this long (default 120 s). */
  timeoutMs?: number
}

export async function execIn(
  docker: Dockerode,
  container: string,
  cmd: string[],
  opts: ExecOptions = {},
): Promise<ExecResult> {
  const c = docker.getContainer(container)
  const exec = await c.exec({
    Cmd: cmd,
    AttachStdin: false,
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
    User: opts.user,
    WorkingDir: opts.workingDir,
    Env: opts.env,
  })
  const stream = await exec.start({ hijack: true, stdin: false })
  const out = new PassThrough()
  const err = new PassThrough()
  const outChunks: Buffer[] = []
  const errChunks: Buffer[] = []
  out.on('data', (b: Buffer) => outChunks.push(b))
  err.on('data', (b: Buffer) => errChunks.push(b))
  docker.modem.demuxStream(stream, out, err)

  const timeoutMs = opts.timeoutMs ?? 120_000
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => {
      stream.destroy()
      reject(new Error(`exec timed out after ${timeoutMs} ms: ${cmd[0]}`))
    }, timeoutMs)
    const done = () => { clearTimeout(t); resolve() }
    stream.on('end', done)
    stream.on('close', done)
    stream.on('error', (e: Error) => { clearTimeout(t); reject(e) })
  })

  // The exec's ExitCode can lag the end of the stream by a few ms.
  let exitCode: number | null = null
  for (let i = 0; i < 50; i++) {
    const info = await exec.inspect()
    if (!info.Running && info.ExitCode !== null && info.ExitCode !== undefined) {
      exitCode = info.ExitCode
      break
    }
    await new Promise((r) => setTimeout(r, 50))
  }
  return {
    exitCode: exitCode ?? -1,
    stdout: Buffer.concat(outChunks).toString('utf8'),
    stderr: Buffer.concat(errChunks).toString('utf8'),
  }
}
