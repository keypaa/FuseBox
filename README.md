# FuseBox

A Firecracker microVM sandbox reproducing Anthropic's Claude code-execution
environment, split into two layers:

```
┌─────────────────────────────────────────────┐
│  console/          the visual layer         │
│  zero-build xterm.js terminal, speaks only  │
│  the firmware WebSocket protocol            │
└──────────────────┬──────────────────────────┘
                   │  ws://192.0.2.2:2024
                   │  raw bytes ⇄ JSON envelopes
┌──────────────────▼──────────────────────────┐
│  sandbox/          the firmware             │
│  custom 6.18.5 kernel · process_api (PID 1) │
│  PTY shell · skills/filestore mounts        │
│  Control API :2025 · Firecracker + TAP      │
└─────────────────────────────────────────────┘
```

| Directory | What it is | Docs |
|-----------|------------|------|
| `sandbox/` | The microVM firmware: kernel, initrd, PID-1 supervisor, network, drives | [sandbox/README.md](sandbox/README.md) · [docs/](docs/) |
| `console/` | The visual layer: zero-build web terminal over the firmware WS API | [console/README.md](console/README.md) |
| `docs/history/` | Harness-era material, parked | [docs/history/README.md](docs/history/README.md) |

## Quick start

```bash
cd sandbox
cargo build --release --target x86_64-unknown-linux-musl --manifest-path process_api/Cargo.toml
(cd initrd && ./build-initrd.sh)
sudo ./network/setup-tap.sh          # once per reboot
sudo ./firecracker/launch.sh         # boots the VM

xdg-open console/index.html          # terminal at ws://192.0.2.2:2024
```

Interactive shell, skills mounts, and the control API are verified by the
automated suites — see the tables in `sandbox/README.md`.
