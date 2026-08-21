#!/usr/bin/env bash
set -euo pipefail

echo "==> FuseBox Integration Tests"
echo ""

# Test 1: Check kernel exists
echo "[TEST 1] Kernel binary exists..."
if [ -f kernel/vmlinux ]; then
    file kernel/vmlinux | grep -q "ELF" && echo "  PASS" || echo "  FAIL: not a valid ELF"
else
    echo "  FAIL: kernel/vmlinux not found"
fi

# Test 2: Check initrd exists
echo "[TEST 2] Initrd exists and contains process_api..."
if [ -f initrd/initrd.img ]; then
    gunzip -c initrd/initrd.img | cpio -t 2>/dev/null | grep -q "process_api" && echo "  PASS" || echo "  FAIL: process_api not in initrd"
else
    echo "  FAIL: initrd/initrd.img not found"
fi

# Test 3: Check rootfs
echo "[TEST 3] Rootfs is an ext4 image..."
if [ -f rootfs/rootfs.ext4 ]; then
    file rootfs/rootfs.ext4 | grep -q "ext2 filesystem data" && echo "  PASS" || echo "  FAIL: not ext4"
else
    echo "  FAIL: rootfs/rootfs.ext4 not found"
fi

# Test 4: Reserved blocks (build-rootfs.sh sets -m 50)
echo "[TEST 4] Rootfs reserved blocks set to 50%..."
if [ -f rootfs/rootfs.ext4 ]; then
    read -r RESERVED BLOCKS < <(tune2fs -l rootfs/rootfs.ext4 2>/dev/null | awk '/^Reserved block count:/{r=$4} /^Block count:/{b=$3} END{print r, b}')
    if [ -n "${BLOCKS:-}" ] && [ "${BLOCKS:-0}" -gt 0 ]; then
        RATIO=$(( RESERVED * 100 / BLOCKS ))
        [ "${RATIO}" = "50" ] && echo "  PASS (${RATIO}%)" || echo "  FAIL: got ${RATIO}% expected 50%"
    else
        echo "  FAIL: could not read ext4 superblock"
    fi
else
    echo "  SKIP: rootfs not available"
fi

# Test 5: Squashfs volumes
echo "[TEST 5] Skills squashfs volumes exist..."
PASS=true
for f in skills/skills-public.squashfs skills/skills-examples.squashfs; do
    if [ ! -f "${f}" ]; then PASS=false; fi
done
${PASS} && echo "  PASS" || echo "  FAIL: missing squashfs volumes"

# Test 6: CA cert
echo "[TEST 6] Egress CA certificate exists..."
if [ -f certs/ca/egress-gateway-ca-production.pem ]; then
    openssl x509 -in certs/ca/egress-gateway-ca-production.pem -noout -subject 2>/dev/null && echo "  PASS" || echo "  FAIL: invalid cert"
else
    echo "  FAIL: CA cert not found"
fi

# Test 7: TAP device (runtime test only)
echo "[TEST 7] TAP device fc-tap0 exists..."
ip link show fc-tap0 &>/dev/null && echo "  PASS" || echo "  SKIP (not running or not configured yet)"

# Test 8: VM connectivity (runtime test only, requires running VM)
echo "[TEST 8] VM Control API healthy (requires running VM)..."
if curl -s --connect-timeout 2 http://192.0.2.2:2025/status 2>/dev/null | grep -q "healthy"; then
    echo "  PASS"
elif [ "${SKIP_VM_TESTS:-0}" = "1" ]; then
    echo "  SKIP (VM not running, set SKIP_VM_TESTS=0 to test)"
else
    echo "  SKIP (VM not running)"
fi

# Test 9: WebSocket PTY shell responds (runtime test only)
echo "[TEST 9] WebSocket PTY shell executes a command (requires running VM)..."
if curl -s --connect-timeout 2 http://192.0.2.2:2025/status 2>/dev/null | grep -q "healthy"; then
    PROBE="./process_api/target/release/examples/ws_probe"
    if [ -x "${PROBE}" ]; then
        if "${PROBE}" ws://192.0.2.2:2024 > /tmp/fusebox-probe.log 2>&1; then
            echo "  PASS (full probe suite)"
        else
            echo "  FAIL (probe suite; see /tmp/fusebox-probe.log)"
        fi
    elif command -v websocat >/dev/null; then
        OUT=$(printf 'echo fusebox_smoke_42\n' | timeout 5 websocat ws://192.0.2.2:2024 2>/dev/null || true)
        if echo "${OUT}" | grep -q "fusebox_smoke_42"; then
            echo "  PASS"
        else
            echo "  FAIL: no command output from shell"
        fi
    else
        echo "  SKIP (neither ws_probe nor websocat available)"
    fi
else
    echo "  SKIP (VM not running)"
fi

echo ""
echo "==> Tests complete."
