// Phase 0 spike: interactive PTY from a container to a browser terminal.
// dockerode exec (Tty:true) <-> ws. No node-pty.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Docker from 'dockerode';
import { WebSocketServer } from 'ws';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 7681);
const IMAGE = process.env.IMAGE ?? 'colony-agent:dev';
const NAME = process.env.CONTAINER ?? 'colony-pty-spike';

// new Docker() with no args auto-detects: DOCKER_HOST if set, else //./pipe/docker_engine on
// win32, else /var/run/docker.sock. Spelled out here for clarity.
const docker = new Docker(
  process.env.DOCKER_HOST ? undefined
    : process.platform === 'win32' ? { socketPath: '//./pipe/docker_engine' }
    : { socketPath: '/var/run/docker.sock' },
);

async function ensureContainer() {
  const c = docker.getContainer(NAME);
  try {
    const info = await c.inspect();
    if (!info.State.Running) await c.start();
    console.log(`[docker] reusing ${NAME} (${info.Id.slice(0, 12)})`);
    return c;
  } catch (e) {
    if (e.statusCode !== 404) throw e;
  }
  const created = await docker.createContainer({
    name: NAME,
    Image: IMAGE,
    Cmd: ['sleep', 'infinity'],
    HostConfig: { Memory: 1024 * 1024 * 1024, Binds: [] },
    Labels: { 'colony.spike': '03-pty' },
  });
  await created.start();
  console.log(`[docker] started ${NAME} (${created.id.slice(0, 12)})`);
  return created;
}

const container = await ensureContainer();

const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    fs.createReadStream(path.join(HERE, 'public', 'index.html')).pipe(res);
    return;
  }
  res.writeHead(404).end();
});

const wss = new WebSocketServer({ server, path: '/pty' });
let nextId = 1;

wss.on('connection', async (ws, req) => {
  const id = nextId++;
  const url = new URL(req.url, 'http://x');
  const cols = Number(url.searchParams.get('cols')) || 80;
  const rows = Number(url.searchParams.get('rows')) || 24;
  console.log(`[ws ${id}] connect ${cols}x${rows}`);

  let exec;
  let stream;
  let closed = false;
  const pending = []; // input that arrives before the exec stream is ready

  // Docker does NOT hang up the pty when the hijacked connection closes: a detached `bash -l`
  // keeps running forever (verified). So the shell writes its in-container pid to a file and on
  // disconnect we kill it from a second exec: SIGHUP (bash forwards it to its jobs, like closing
  // a real terminal), then SIGKILL if it is still alive 2 s later.
  const pidFile = `/tmp/colony-pty-${process.pid}-${id}.pid`;
  const killShell = async () => {
    const script = `p=$(cat ${pidFile} 2>/dev/null) || exit 0; kill -HUP "$p" 2>/dev/null; ` +
      `for i in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$p" 2>/dev/null || break; sleep 0.2; done; ` +
      `kill -KILL "$p" 2>/dev/null; rm -f ${pidFile}`;
    try {
      const k = await container.exec({ Cmd: ['sh', '-c', script], AttachStdout: false, AttachStderr: false });
      await k.start({ Detach: true });
    } catch (e) { console.warn(`[ws ${id}] kill exec failed: ${e.message}`); }
  };

  const cleanup = (why) => {
    if (closed) return;
    closed = true;
    console.log(`[ws ${id}] cleanup: ${why}`);
    if (exec) killShell();
    try { stream?.end(); } catch {}
    try { stream?.destroy(); } catch {}
    if (ws.readyState === ws.OPEN) ws.close();
  };

  ws.on('close', () => cleanup('ws closed'));
  ws.on('error', (e) => cleanup(`ws error ${e.message}`));
  ws.on('message', (data, isBinary) => {
    // Protocol: text frames are JSON control messages; binary frames are terminal input.
    // (Non-JSON text frames are tolerated and treated as input.)
    if (!isBinary) {
      const text = data.toString('utf8');
      let msg = null;
      try { msg = JSON.parse(text); } catch {}
      if (msg && typeof msg === 'object' && typeof msg.type === 'string') {
        if (msg.type === 'resize' && exec) {
          const w = Math.max(1, msg.cols | 0);
          const h = Math.max(1, msg.rows | 0);
          exec.resize({ w, h }).catch((e) => console.warn(`[ws ${id}] resize failed: ${e.message}`));
        }
        return;
      }
    }
    if (stream) stream.write(data); else pending.push(data);
  });

  try {
    exec = await container.exec({
      // `exec` keeps the pid, so the recorded pid is the interactive login shell itself.
      Cmd: ['bash', '-c', `echo $$ > ${pidFile}; exec bash -l`],
      AttachStdin: true, AttachStdout: true, AttachStderr: true,
      Tty: true,
      Env: ['TERM=xterm-256color'],
    });
    // ConsoleSize (Engine API >= 1.42) sets the initial size before bash starts, so the first
    // prompt is laid out correctly. resize() right after covers older engines.
    stream = await exec.start({ hijack: true, stdin: true, Tty: true, ConsoleSize: [rows, cols] });
    if (closed) { stream.destroy(); return; }
    await exec.resize({ w: cols, h: rows }).catch(() => {});
    // With Tty:true the stream is raw (no 8-byte multiplex headers), so no demuxing needed.
    stream.on('data', (chunk) => { if (ws.readyState === ws.OPEN) ws.send(chunk, { binary: true }); });
    stream.on('end', () => cleanup('exec stream ended (shell exited)'));
    stream.on('error', (e) => cleanup(`exec stream error ${e.message}`));
    for (const d of pending.splice(0)) stream.write(d);
  } catch (e) {
    console.error(`[ws ${id}] exec failed`, e);
    if (ws.readyState === ws.OPEN) ws.close(1011, 'exec failed');
    cleanup('exec failed');
  }
});

server.listen(PORT, '127.0.0.1', () => console.log(`[http] http://127.0.0.1:${PORT}/  (ws: /pty)`));

const shutdown = async () => {
  console.log('[server] shutting down');
  for (const c of wss.clients) c.terminate();
  server.close();
  if (process.env.KEEP_CONTAINER !== '1') {
    await container.remove({ force: true }).catch((e) => console.warn(e.message));
    console.log(`[docker] removed ${NAME}`);
  }
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
