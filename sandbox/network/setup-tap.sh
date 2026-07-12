#!/usr/bin/env bash
set -euo pipefail

TAP_DEV="fc-tap0"
GUEST_IP="192.0.2.2"
GATEWAY_IP="192.0.2.1"
GATEWAY_MAC="02:fc:00:00:00:05"
MTU=1400

echo "==> Creating TAP device: ${TAP_DEV}"
ip tuntap add "${TAP_DEV}" mode tap

echo "==> Assigning gateway IP: ${GATEWAY_IP}/24"
ip addr add "${GATEWAY_IP}/24" dev "${TAP_DEV}"

echo "==> Setting MTU=${MTU} and MAC=${GATEWAY_MAC}"
ip link set "${TAP_DEV}" mtu "${MTU}" up
ip link set "${TAP_DEV}" address "${GATEWAY_MAC}"

echo "==> Enabling IP forwarding"
echo 1 > /proc/sys/net/ipv4/ip_forward

echo "==> Redirecting VM egress (80/443) to Envoy on ${GATEWAY_IP}:1080/1443"
# Transparent interception: guest traffic to arbitrary :80/:443 is DNAT'd to
# the Envoy listeners (kept off host 80/443 to avoid clashing with traefik).
iptables -t nat -A PREROUTING -i "${TAP_DEV}" -p tcp --dport 80 -j DNAT --to-destination "${GATEWAY_IP}:1080"
iptables -t nat -A PREROUTING -i "${TAP_DEV}" -p tcp --dport 443 -j DNAT --to-destination "${GATEWAY_IP}:1443"

echo "==> Configuring NAT (MASQUERADE) for VM outbound"
iptables -t nat -A POSTROUTING -o "$(ip route show default | awk '{print $5}' | head -1)" -j MASQUERADE
iptables -A FORWARD -i "${TAP_DEV}" -o "$(ip route show default | awk '{print $5}' | head -1)" -j ACCEPT
iptables -A FORWARD -i "$(ip route show default | awk '{print $5}' | head -1)" -o "${TAP_DEV}" -m state --state RELATED,ESTABLISHED -j ACCEPT

echo "==> TAP device ${TAP_DEV} ready."
ip addr show "${TAP_DEV}"
