#!/usr/bin/env bash
set -euo pipefail

TAP_DEV="fc-tap0"

echo "==> Removing TAP device: ${TAP_DEV}"
ip link set "${TAP_DEV}" down 2>/dev/null || true
ip tuntap del "${TAP_DEV}" mode tap 2>/dev/null || true

echo "==> Cleaning iptables rules..."
DEFAULT_IFACE=$(ip route show default | awk '{print $5}' | head -1)
iptables -t nat -D POSTROUTING -o "${DEFAULT_IFACE}" -j MASQUERADE 2>/dev/null || true
iptables -D FORWARD -i "${TAP_DEV}" -o "${DEFAULT_IFACE}" -j ACCEPT 2>/dev/null || true
iptables -D FORWARD -i "${DEFAULT_IFACE}" -o "${TAP_DEV}" -m state --state RELATED,ESTABLISHED -j ACCEPT 2>/dev/null || true

echo "==> Done."
