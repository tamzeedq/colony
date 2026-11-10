# Spike 03: interactive PTY from a container to xterm.js

**Question:** can the control plane give the Inspector "Terminal" tab a real interactive shell inside an
agent container, with resize and Ctrl-C, without `node-pty` (no native builds on Windows)?

**Answer: yes.** A Docker exec with `Tty: true` is a PTY that lives inside the container, and Docker owns it.
`dockerode` hijacks the exec's HTTP connection into a raw duplex stream, and we pipe that to a WebSocket.
Resize goes through `exec.resize()`. Signals such as Ctrl-C work because the bytes go to a real tty line
discipline. The only native-looking part is the Windows named pipe, and dockerode handles it in plain JS.

## Files

| File | What |
|---|---|
| `server.mjs` | HTTP + WS server (dockerode, ws). Makes sure the container is running, then gives each WebSocket its own `bash -l` exec. |
| `public/index.html` | xterm.js 5.5.0 + addon-fit 0.10.0 from jsdelivr (pinned), FitAddon + ResizeObserver |
| `test.mjs` | Headless test client (no browser needed) |

## Run

```sh
cd spikes/03-pty
npm install --no-workspaces     # spikes/ is not a workspace; keeps the root lockfile out of it
npm start                       # starts container colony-pty-spike from colony-agent:dev, listens on 127.0.0.1:7681
# browser: http://127.0.0.1:7681/
npm test                        # in a second shell, with the server running
# teardown (Ctrl-C on the server removes the container too; on Windows a hard kill does not):
docker rm -f colony-pty-spike
```

Environment knobs: `PORT` (7681), `IMAGE` (`colony-agent:dev`), `CONTAINER` (`colony-pty-spike`),
`KEEP_CONTAINER=1` (leave it running on shutdown), `DOCKER_HOST`.

Container: `colony-agent:dev`, name `colony-pty-spike`, `Memory: 1 GiB`, `Binds: []` (no mounts at all,
checked with `docker inspect`: `mounts=0`), `Cmd: ["sleep","infinity"]` (tini is PID 1 from the image).

## Protocol (WebSocket `/pty`)

- **Connect:** `ws://host/pty?cols=<n>&rows=<n>` sets the initial size. The server passes it as `ConsoleSize`
  to exec start, so bash's first prompt is laid out at the right width. Checked: `cols=101&rows=33` gives
  `stty size` = `33 101` before any resize message is sent.
- **Client to server, binary frame:** raw terminal input bytes (keystrokes, paste, `\x03`).
- **Client to server, text frame:** JSON control message. Today that is only `{"type":"resize","cols":N,"rows":N}`.
  A text frame that doesn't parse as `{type:...}` JSON is treated as input, so the format is forgiving, but
  clients should always send input as binary.
- **Server to client, binary frame:** raw PTY output bytes (UTF-8 and ANSI escapes). Pass them straight to
  `term.write(Uint8Array)`.
- **Close:** the server closes the socket when the shell exits. When the client goes away, the server kills
  the shell (see Gotchas).

Keeping input binary and control messages text means you never need to escape anything or sniff for
`{"type"` inside keystrokes.

## Verified results (2026-11-09, Windows 11, Docker Desktop engine 29.9.2 / API 1.56, Node 22, dockerode 4.0.12, ws 8.22.2)

`npm test` output:

```
PASS  got a bash prompt
      raw: ["echo PTY_OK && tput cols && tput lines && whoami","PTY_OK","132","40","node"]
PASS  output contains PTY_OK
PASS  tput cols == 132  (got 132)
PASS  tput lines == 40  (got 40)
PASS  whoami == node  (got node)
PASS  stdin is a real tty  (/dev/pts/0)
PASS  TERM=xterm-256color  (got xterm-256color)
PASS  Ctrl-C (\x03) interrupts sleep 100  (exit 130, 545 ms incl. 500 ms wait)
PASS  server closes ws when shell exits
PASS  abrupt disconnect: sleep 777 was running
PASS  abrupt disconnect: no bash / sleep 777 left behind  []

11/11 passed
```

The test connects at 80x24, sends `{"type":"resize","cols":132,"rows":40}`, then runs
`echo PTY_OK && tput cols && tput lines && whoami`. It sends `sleep 100`, waits 500 ms, sends `\x03`, and
gets the prompt back. `$?` is 130 (SIGINT). Next it sends `exit` and checks that the server closes the WS.
Last, it opens a second WS, starts `sleep 777`, hard-terminates the socket, and reads `/proc` in the container
to check that nothing is left behind.

Server log for that run:

```
[docker] started colony-pty-spike (7601b7393f83)
[http] http://127.0.0.1:7681/  (ws: /pty)
[ws 1] connect 80x24
[ws 1] cleanup: exec stream ended (shell exited)
[ws 2] connect 80x24
[ws 2] cleanup: ws closed
```

All three CDN URLs returned HTTP 200. The browser page was **not** looked at visually: only the HTTP 200 of
`index.html` and the CDN assets was checked. The WS path the page uses is the same one the test uses.

## Gotchas

1. **Closing the connection does not end the shell (important).** The first version only did `stream.end()`
   and `destroy()` on disconnect. A `bash -l` whose client had gone was still running in the container
   afterwards (seen in `/proc`). Docker doesn't send a hangup to the pty when the hijacked connection closes,
   and exec sessions can't be killed through the API. Fix used here: the exec runs
   `bash -c 'echo $$ > /tmp/colony-pty-<id>.pid; exec bash -l'`. On disconnect, a second detached exec sends
   `kill -HUP <pid>`, which bash forwards to its jobs the way closing a real terminal would. If the shell is
   still alive 2 s later it gets SIGKILL. Children that ignore SIGHUP (`nohup`, `setsid`) survive, which is the
   usual Unix behavior. The control plane needs this, or something like it, or every closed tab leaks a shell.
2. **Docker socket on Windows.** `new Docker()` with no options already detects `//./pipe/docker_engine`
   on win32 (and honors `DOCKER_HOST`). `server.mjs` spells it out as `{ socketPath: '//./pipe/docker_engine' }`.
   No native modules are *needed*. One caveat: dockerode depends on `docker-modem`, which depends on `ssh2`, and
   ssh2 has an **optional** native dependency `cpu-features` (node-gyp). On this machine it compiled (it left a
   `build/Release`), but it is optional, so the install still works where there's no toolchain, and the named
   pipe never touches ssh2. To make sure nothing native ever builds, install with `--omit=optional`.
3. **`Tty: true` means a raw stream.** No 8-byte multiplex headers and no stdout/stderr split, so don't call
   `docker.modem.demuxStream`. (Non-tty execs, like the `/proc` reader in `test.mjs`, *are* multiplexed.)
4. **Initial size.** Without `ConsoleSize` the shell starts at Docker's default and the first prompt can wrap
   wrongly. Pass `ConsoleSize: [rows, cols]` to `exec.start` (API 1.42 or later), then call `exec.resize` too
   for older engines. `resize` fails if called before start, so resize messages that arrive too early are dropped.
5. **Ctrl-C and `;` lists.** `sleep 100; echo $?` followed by `^C` prints nothing after the interrupt, because
   bash drops the rest of the list when SIGINT kills the foreground job. That is normal shell behavior, not a
   PTY bug. The test reads `$?` with a separate command.
6. **The image has no `ps`/procps.** Use `/proc` for inspection, or add `procps` to the agent image if
   operators will want `ps`/`top` in the shell.
7. **On Windows, a hard kill skips cleanup.** `taskkill /F` on the server doesn't run the SIGINT handler, so
   the container stays. In the control plane, container lifecycle belongs to the agent supervisor, not the
   terminal handler, so this only matters for the spike.

## Recommendation for the control plane

- **Endpoint:** `GET /api/agents/:agentId/terminal` upgraded to WS, using the protocol above unchanged. The
  control plane resolves `agentId` to its container. The client never sends a container ID or a command:
  the server fixes `Cmd` (`bash -l`, as user `node`, `WorkingDir` set to the agent's worktree). There is no
  `User: root` option from the UI.
- **Auth:** check auth **during the upgrade** (reject before `handleUpgrade`), not after connecting. Use the
  same session cookie as the REST API plus an `Origin` allowlist (protects against cross-site WebSocket
  hijacking). Or, more simply, have an authenticated `POST .../terminal/ticket` return a short-lived (around 30 s),
  single-use ticket that goes in the WS URL. Bind to 127.0.0.1 by default. A shell in the container can reach
  everything the agent can (worktree, `CLAUDE_CODE_OAUTH_TOKEN` in env), so treat it like a privileged action:
  log open and close events (who, agent, duration) to the activity feed as `ActivityEvent`s.
- **One exec per tab/connection,** never shared. Each WS gets its own `bash -l` exec and pid file, and it is
  killed when the WS closes (gotcha 1). Cap concurrent terminals per agent (e.g. 4) and add an idle timeout.
  Add WS ping/pong (e.g. every 20 s) so half-open browser connections are noticed and cleaned up. Reconnecting
  means a new shell. If the UI wants scrollback to survive reconnects, put `tmux` in the image and have the
  exec run `tmux new -A -s tab-<n>` instead of adding server-side buffering.
- **Never bind-mount the Docker socket** to get this working: the control plane talks to the engine from
  the host, and the container only ever sees its pty. That fits the CLAUDE.md hard rules.
- **Take-control "shell mode":** the agent's `claude -p` stream-json process is not a TTY and must not be
  attached to. When the human takes control: (1) the supervisor pauses the agent (stops feeding stream-json
  input and lets the current turn finish, or interrupts it), (2) records a `takeover` `ActivityEvent` with the
  human's identity, (3) opens a terminal exec as above in the agent's worktree, maybe with a banner/PS1 that
  says "you are in agent X's container", (4) on release, kills the exec (gotcha 1), records the end of the
  takeover, and lets the agent continue, with a note in its next input saying what the human changed
  (`git status`/diff summary). Shell mode and the read-only Inspector terminal can share the same endpoint.
  A `mode=takeover` query flag only changes the supervisor state machine, not the PTY plumbing.
- **Backpressure:** for big outputs (`cat` of a large file), pause the exec stream when `ws.bufferedAmount`
  goes over a threshold and resume on drain. The spike doesn't do this, and it's needed before production.
