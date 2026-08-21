#!/usr/bin/env bash
set -euo pipefail

TAP_DEV="fc-tap0"
GUEST_IP="192.0.2.2"
GATEWAY_IP="192.0.2.1"
GATEWAY_MAC="02:fc:00:00:00:05"
MTU=1400

# Idempotent: remove a stale TAP left over from a previous run (re-running
# this script used to abort with "ioctl(TUNSETIFF): Device or resource busy").
if ip link show "${TAP_DEV}" &>/dev/null; then
    echo "==> Removing stale TAP device: ${TAP_DEV}"
    ip link delete "${TAP_DEV}"
fi

echo "==> Creating TAP device: ${TAP_DEV}"
ip tuntap add "${TAP_DEV}" mode tap

echo "==> Assigning gateway IP: ${GATEWAY_IP}/24"
ip addr add "${GATEWAY_IP}/24" dev "${TAP_DEV}"

echo "==> Setting MTU=${MTU} and MAC=${GATEWAY_MAC}"
ip link set "${TAP_DEV}" mtu "${MTU}" up
ip link set "${TAP_DEV}" address "${GATEWAY_MAC}"

echo "==> Enabling IP forwarding"
echo 1 > /proc/sys/net/ipv4/ip_forward

# Append a rule only when it is not already present, so repeated runs don't
# pile up duplicate DNAT/MASQ entries.
add_rule() {
    local table="$1"; shift
    if iptables -t "$table" -C "$@" 2>/dev/null; then
        echo "    already present: $*"
    else
        iptables -t "$table" -A "$@"
    fi
}

WAN_IF="$(ip route show default | awk '{print $5}' | head -1)"

echo "==> Redirecting VM egress (80/443) to Envoy on ${GATEWAY_IP}:1080/1443"
# Transparent interception: guest traffic to arbitrary :80/:443 is DNAT'd to
# the Envoy listeners (kept off host 80/443 to avoid clashing with traefik).
add_rule nat PREROUTING -i "${TAP_DEV}" -p tcp --dport 80 -j DNAT --to-destination "${GATEWAY_IP}:1080"
add_rule nat PREROUTING -i "${TAP_DEV}" -p tcp --dport 443 -j DNAT --to-destination "${GATEWAY_IP}:1443"

echo "==> Configuring NAT (MASQUERADE) for VM outbound"
add_rule nat POSTROUTING -o "${WAN_IF}" -j MASQUERADE
add_rule filter FORWARD -i "${TAP_DEV}" -o "${WAN_IF}" -j ACCEPT
add_rule filter FORWARD -i "${WAN_IF}" -o "${TAP_DEV}" -m state --state RELATED,ESTABLISHED -j ACCEPT

echo "==> TAP device ${TAP_DEV} ready."
ip addr show "${TAP_DEV}"
