# FuseBox Documentation

Technical documentation for the FuseBox Firecracker sandbox.

## Files

- [architecture.md](architecture.md) — system design, boot chain, networking
- [build.md](build.md) — build instructions for each component
- [troubleshooting.md](troubleshooting.md) — known issues, debugging, root causes
- [websocket.md](websocket.md) — WebSocket protocol reference

## Quick Reference

| Resource | Location |
|----------|----------|
| Kernel config | `sandbox/kernel/microvm.config` |
| Firecracker config | `sandbox/firecracker/vm-config.json` |
| Launch script | `sandbox/firecracker/launch.sh` |
| TAP setup | `sandbox/network/setup-tap.sh` |
| Initrd build | `sandbox/initrd/build-initrd.sh` |
| Serial log | `/tmp/fusebox-serial.log` |
| FC API socket | `/tmp/fusebox-fc.sock` |
