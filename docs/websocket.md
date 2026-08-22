# WebSocket Protocol

## Connection

```
ws://192.0.2.2:2024
```

Each WebSocket connection spawns a **PTY-backed interactive `/bin/bash`**: the
shell runs as a session leader with the pty as its controlling terminal, so it
behaves like a real terminal — PS1 prompt, readline (arrow keys, tab
completion), job control, and signal keys all work. The connection closes when
the shell exits or the client disconnects.

## Client → Server

### Shell input (raw bytes)

Any Text/Binary frame that is not a control frame is written **verbatim** to
the pty master — exactly the bytes a keyboard would produce:

| Bytes | Effect |
|-------|--------|
| `ls -la\n` | run command |
| `\x1b[A` | Up arrow — recall history |
| `\t` | Tab completion |
| `\x03` | Ctrl-C — SIGINT to foreground job |
| `\x04` | Ctrl-D — EOF |

No framing is added; multi-byte paste works because bash's line discipline
buffers it.

### Control frames (JSON)

A Text frame containing a recognized JSON object with a `"type"` field is
interpreted as a control message:

```json
{"type":"resize","cols":120,"rows":40}
{"type":"ping"}
```

- `resize` → `TIOCSWINSZ` on the pty (kernel raises `SIGWINCH`, so full-screen
  programs like `vim`/`less` repaint). Default size is 80x24.
- `ping` → answered with `{"event":"pong"}`.

Everything else — including JSON-looking text — goes to the shell verbatim.

## Server → Client

Output chunks are streamed as they come out of the pty (not line-buffered):

```json
{"stream":"stdout","text":"root@fusebox:/ \u001b[?2004h"}
```

- Text is properly JSON-escaped (`serde_json`), safe for quotes, backslashes,
  and any UTF-8; incomplete multi-byte sequences are carried across reads
  instead of being mangled at chunk boundaries.
- `stderr` merges into the same stream — inherent to a pty, like a real
  terminal. There is no separate stderr stream.
- Terminal escape sequences (colors, cursor movement) pass through untouched;
  render them with a terminal emulator for the intended display.

On session end:

```json
{"event":"exit","code":0}
```

Exit codes follow shell convention: `N` from exit status, negative `-SIGNAL`
if the shell died to a signal.

### Control API

```
http://192.0.2.2:2025
```

| Method | Path | Description |
|--------|------|-------------|
| GET | `/status` | Health check + active session count |
| GET | `/sessions` | Active shell sessions: `{"sessions":[{"id","pid"}]}` |
| POST | `/mount_root` | Re-run `/mount_config.json` mounts (idempotent) |
| GET | `/files/list?path=P` | JSON listing `{"entries":[{"name","size","is_dir"}]}` |
| GET | `/files/download?path=P` | Raw file bytes as attachment (≤512 MiB) |
| POST | `/files/upload?path=P` | Request body becomes the file's content (≤256 MiB) |

The supervisor runs inside the guest, so the file plane exposes exactly the
sandbox filesystem — that is the point. Paths must be absolute without `..`.
All responses carry permissive CORS so browser clients (including `file://`)
work from any origin.

## Session lifecycle

- Client disconnects → supervisor sends `SIGHUP` to the whole session group,
  escalates to `SIGKILL` after 1.5 s, then reports the exit event.
- By default there is **no idle timeout**. Start process_api with
  `--session-timeout-secs N` to reap sessions after N seconds (0 = disabled).

## Testing

`sandbox/process_api/examples/ws_probe.rs` drives the full matrix (prompt,
execution, arrow-key history, tab completion, Ctrl-C, resize, ping, exit)
against any running instance:

```bash
cargo build --release --example ws_probe   # host target is fine
./target/release/examples/ws_probe ws://192.0.2.2:2024
```
