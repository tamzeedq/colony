// Headless check: connect, resize, run commands, verify Ctrl-C interrupts, verify cleanup.
import WebSocket from 'ws';
import Docker from 'dockerode';

const TARGET = process.env.PTY_URL ?? 'ws://127.0.0.1:7681/pty?cols=80&rows=24';
const COLS = 132;
const ROWS = 40;
const ws = new WebSocket(TARGET);
let out = '';
const results = [];
// Strip CSI / OSC escape sequences and CRs so we can regex the visible text.
const strip = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07|\x1b[()][A-Z0-9]|\r/g, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const docker = new Docker();
// The image has no `ps`, so read /proc. Returns command lines of everything but tini/sleep infinity.
async function procs() {
  const ex = await docker.getContainer(process.env.CONTAINER ?? 'colony-pty-spike').exec({
    Cmd: ['sh', '-c', 'for p in /proc/[0-9]*; do tr "\\0" " " < $p/cmdline; echo; done'],
    AttachStdout: true, AttachStderr: true,
  });
  const s = await ex.start({});
  const chunks = [];
  await new Promise((r) => { s.on('data', (c) => chunks.push(c)); s.on('end', r); });
  // Non-tty exec output is multiplexed: 8-byte header per frame. Demux by hand.
  const buf = Buffer.concat(chunks);
  let txt = '';
  for (let i = 0; i + 8 <= buf.length;) { const n = buf.readUInt32BE(i + 4); txt += buf.subarray(i + 8, i + 8 + n); i += 8 + n; }
  return txt.split('\n').map((l) => l.trim())
    .filter((l) => l && !l.includes('tini') && l !== 'sleep infinity' && !l.includes('/proc/'));
}

function waitFor(re, ms = 10000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const t = setInterval(() => {
      const m = strip(out).match(re);
      if (m) { clearInterval(t); resolve(m); }
      else if (Date.now() - start > ms) {
        clearInterval(t);
        reject(new Error(`timeout waiting for ${re}\n--- output ---\n${JSON.stringify(strip(out))}`));
      }
    }, 25);
  });
}
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
};
const send = (s) => ws.send(Buffer.from(s, 'utf8'), { binary: true });

ws.on('message', (d) => { out += d.toString('utf8'); });
ws.on('open', async () => {
  try {
    await waitFor(/[$#] ?$/); // first prompt
    check('got a bash prompt', true);
    ws.send(JSON.stringify({ type: 'resize', cols: COLS, rows: ROWS }));
    await sleep(200);

    out = '';
    send('echo PTY_OK && tput cols && tput lines && whoami\n');
    const m = await waitFor(/^PTY_OK\n(\d+)\n(\d+)\n(\S+)\n/m);
    console.log('      raw:', JSON.stringify(strip(out).split('\n').slice(0, 5)));
    check('output contains PTY_OK', true);
    check(`tput cols == ${COLS}`, Number(m[1]) === COLS, `(got ${m[1]})`);
    check(`tput lines == ${ROWS}`, Number(m[2]) === ROWS, `(got ${m[2]})`);
    check('whoami == node', m[3] === 'node', `(got ${m[3]})`);

    out = '';
    send('tty; echo TERM=$TERM\n');
    const t = await waitFor(/^(\/dev\/pts\/\d+)\nTERM=(\S+)\n/m);
    check('stdin is a real tty', true, `(${t[1]})`);
    check('TERM=xterm-256color', t[2] === 'xterm-256color', `(got ${t[2]})`);

    out = '';
    const t0 = Date.now();
    // Note: bash aborts the rest of a `a; b` list when SIGINT kills `a`, so check $? separately.
    send('sleep 100\n');
    await sleep(500);
    send('\x03');
    await waitFor(/\^C\n[^\n]*[$#] ?$/, 5000); // prompt is back
    const dt = Date.now() - t0;
    send('echo EXIT=$?\n');
    const e = await waitFor(/EXIT=(\d+)/, 5000);
    check('Ctrl-C (\\x03) interrupts sleep 100', e[1] === '130' && dt < 5000, `(exit ${e[1]}, ${dt} ms incl. 500 ms wait)`);

    send('exit\n');
    await new Promise((resolve) => { ws.once('close', resolve); setTimeout(resolve, 3000); });
    check('server closes ws when shell exits', ws.readyState === WebSocket.CLOSED);

    // Abrupt disconnect while a foreground job runs: nothing may be left in the container.
    const ws2 = new WebSocket(TARGET);
    let out2 = '';
    ws2.on('message', (d) => { out2 += d.toString('utf8'); });
    await new Promise((r) => ws2.once('open', r));
    await sleep(800);
    ws2.send(Buffer.from('sleep 777\n'), { binary: true });
    await sleep(500);
    const before = await procs();
    ws2.terminate();
    await sleep(3500);
    const after = await procs();
    check('abrupt disconnect: sleep 777 was running', before.some((p) => p.includes('sleep 777')));
    check('abrupt disconnect: no bash / sleep 777 left behind',
      !after.some((p) => p.includes('sleep 777') || /^bash/.test(p)), JSON.stringify(after));
  } catch (err) {
    console.error(err.message);
    check('no errors', false);
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  ws.terminate();
  process.exit(failed ? 1 : 0);
});
ws.on('error', (e) => { console.error('ws error', e.message); process.exit(1); });
