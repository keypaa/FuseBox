# Troubleshooting

## Boot Failures

### "ACPI: Unable to load System Description Tables"

**Root cause**: `CONFIG_PCI=n` breaks ACPI on x86_64.

The ACPICA library unconditionally installs a default `ACPI_ADR_SPACE_PCI_CONFIG` handler (`evhandler.c:26-30`), but the handler's case is only compiled when `ACPI_PCI_CONFIGURED` is defined (`aclinux.h:36-38`), which requires `CONFIG_PCI`. Without it, the handler fails with `AE_BAD_PARAMETER`, causing `acpi_load_tables()` to abort (`tbxfload.c:52-53`).

**Fix**: `CONFIG_PCI=y` + `CONFIG_PCI_MSI=y` in `microvm.config`, with `pci=off` in boot args (Firecracker doesn't emulate PCI config ports).

### "error -EBUSY: can't request region for resource"

**Root cause**: Firecracker registers virtio devices both via kernel cmdline (`virtio_mmio.device=`) and ACPI DSDT AML (`_SB_.V000` / `LNRO0005`). Both paths probe the same MMIO addresses; the second probe gets EBUSY.

**Impact**: Benign — devices work via whichever path binds first. Block devices are functional despite these errors.

### Kernel panic / no output

- Check `/tmp/fusebox-serial.log` for output
- Verify `kernel/vmlinux` exists and is a valid ELF
- Ensure `initrd/initrd.img` exists
- Check Firecracker API errors in launch.sh output

## Network Issues

### Guest can't ping host / host can't ping guest

- Verify TAP exists: `ip link show fc-tap0`
- Check TAP is UP and has IP: `ip addr show fc-tap0`
- Verify MAC matches `vm-config.json` (guest_mac `02:fc:00:00:00:01` ↔ host MAC `02:fc:00:00:00:05`)
- Check iptables rules: `sudo iptables -t nat -L -n`

### Guest "SIOCSIFNETMASK failed: Invalid argument"

**Root cause**: Double byte-swap in `configure_interface()`.

```rust
// BUG: .to_be().to_be_bytes() double-swaps on little-endian
let mask: u32 = netmask.parse::<Ipv4Addr>().map(|a| u32::from(a).to_be()).unwrap_or(0);
let mask_bytes = mask.to_be_bytes(); // → [00 FF FF FF] instead of [FF FF FF 00]
```

Kernel's `bad_mask()` rejects the corrupted mask value. Same bug silently corrupted the IP address.

**Fix**: Drop `.to_be()` — `u32::from(a).to_be_bytes()` produces correct network-order bytes directly.

### "Open tap device failed: Resource busy"

TAP device exists but is held by another Firecracker process. Kill stale processes:

```bash
sudo pkill firecracker
sudo rm -f /tmp/fusebox-fc.sock
sudo ip link del fc-tap0 2>/dev/null
```

## WebSocket Shell Issues

### "Process initialization collapse: No such file or directory"

**Root cause**: `/bin/bash` missing from initrd.

**Fix**: Run `sandbox/tools/fetch-static-binaries.sh` and rebuild initrd. The build script installs static bash at `/bin/bash`.

### "ls: command not found"

**Root cause**: Initrd only had bash, no coreutils.

**Fix**: Static busybox provides coreutils via symlinks (`/bin/ls` → busybox). Rebuild initrd after running `fetch-static-binaries.sh`.

### "whoami: unknown uid 0"

**Root cause**: No `/etc/passwd` in initrd.

**Fix**: `build-initrd.sh` now creates `/etc/passwd` and `/etc/group` with root/nobody entries.

### No prompt shown in websocat

Historical — the shell is PTY-backed now. If a connection yields no output,
check the serial log for `PTY allocation failure` and see the PTY section
below.

## PTY / Shell Session Issues

### "PTY allocation failure: No such file or directory" (guest)

**Root cause**: devpts is never mounted. Modern kernels refuse `/dev/ptmx`
opens unless a devpts instance is mounted: `ptmx_open` → `devpts_acquire` →
`path_pts` looks for a devpts mount at `pts/` beside the device node and
fails with ENOENT if absent — even though `CONFIG_UNIX98_PTYS=y` and the
node exists (devpts is compiled in implicitly; it has no standalone Kconfig
symbol anymore).

**Fix**: process_api mounts `devpts` at `/dev/pts` during init (with a
plain-options retry and kmsg logging of both attempts). Verify with
`grep devpts /proc/mounts` via a session or the serial log line
`devpts mounted at /dev/pts`.

### "PTY allocation failure: Not a tty" (ENOTTY)

**Root cause**: wrong ioctl magic for `TIOCGPTN`. It is `_IOR('T', 0x30)` =
`0x80045430` (capital T). A lowercase `'t'` (0x74) produces an unknown
request → ENOTTY even though everything else is healthy.

### Ctrl-C echoed (`^C`) but nothing happens; foreground jobs unkillable

**Root cause**: the supervisor was launched from a context that ignores
SIGINT/SIGQUIT/SIGPIPE (e.g. a background job of a non-interactive shell —
POSIX makes async jobs ignore INT/QUIT). Ignored dispositions inherit
across `fork`+`exec`, and POSIX forbids a non-interactive shell from
resetting signals ignored on entry — so bash cannot install its INT
handler and every child (including `sleep`) ignores Ctrl-C. The tty still
echoes `^C`, which makes it look like signal *delivery* is broken when the
disposition is the problem. Diagnostic signature: `SigIgn: 0000000000001006`
in `/proc/<child>/status` while `tpgid` is correct.

**Fix**: process_api resets the three dispositions to `SIG_DFL` at startup
(`main()`), making session behavior launch-context independent. When
launching test instances manually, prefer a fresh background job or a
python `execv` wrapper that resets dispositions.

## Debug Tips

```bash
# Watch serial output in real time
tail -f /tmp/fusebox-serial.log

# Check Firecracker API
curl --unix-socket /tmp/fusebox-fc.sock http://localhost/machine-config

# Check VM health
curl http://192.0.2.2:2025/status

# Run the full interactive-shell probe suite against the VM
cd sandbox/process_api && cargo build --release --example ws_probe
./target/release/examples/ws_probe ws://192.0.2.2:2024

# Kill stuck VM
sudo pkill firecracker
```
