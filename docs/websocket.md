# WebSocket Protocol

## Connection

```
ws://192.0.2.2:2024
```

Each WebSocket connection spawns a new `/bin/bash` subprocess. The connection is closed when the subprocess exits or the client disconnects.

## Client → Server (Commands)

Send commands as **plain text** messages (not JSON). Each command must end with `\n`.

```
echo "hello world"
ls /
cat /etc/hosts
```

There is no command framing — the server writes raw bytes to bash's stdin.

## Server → Client (Output)

Output is delivered as **JSON objects** with a `stream` field:

```json
{"stream":"stdout","text":"hello world"}
{"stream":"stderr","text":"/bin/bash: line 1: badcmd: command not found"}
```

On subprocess exit:

```json
{"event":"exit","code":0}
```

### Stream Types

| Field | Description |
|-------|-------------|
| `stream: "stdout"` | Standard output from the subprocess |
| `stream: "stderr"` | Standard error from the subprocess |
| `event: "exit"` | Process terminated (with exit code) |

### Line-Based Relay

Output is relayed **line-by-line**. A line is defined as bytes ending with `\n`. If a command produces output without a trailing newline (e.g., a prompt), it will be buffered until the next newline appears.

This means:
- `echo hi` → one JSON message: `{"stream":"stdout","text":"hi"}`
- `ls /` → one JSON message per line
- Prompt text (no `\n`) → buffered, not visible until next newline

## Control API

```
http://192.0.2.2:2025
```

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/status` | Health check |
| POST | `/mount_root` | Inject session-specific mount config |

## Limitations

- **No PTY**: bash runs without a pseudo-terminal. No interactive prompt, no arrow key history, no tab completion.
- **Single command per message**: each WebSocket text message is written verbatim to stdin. Multi-line commands work if they include `\n`.
- **Line-buffered output**: output without trailing newline is delayed.
- **No signal forwarding**: Ctrl+C in websocat closes the WebSocket, it doesn't send SIGINT to bash.
