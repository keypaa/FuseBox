#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CERT_DIR="${SCRIPT_DIR}/../certs"

mkdir -p "${CERT_DIR}/ca" "${CERT_DIR}/guest"

echo "==> Generating Egress Gateway Root CA..."
openssl genrsa -out "${CERT_DIR}/ca/egress-ca.key" 4096

openssl req -new -x509 -days 3650 \
  -key "${CERT_DIR}/ca/egress-ca.key" \
  -subj "/O=FuseBox/CN=Egress Gateway SDS Issuing CA (production)" \
  -out "${CERT_DIR}/ca/egress-gateway-ca-production.pem"

echo "==> Creating CA bundle for guest VM..."
cp "${CERT_DIR}/ca/egress-gateway-ca-production.pem" "${CERT_DIR}/guest/egress-gateway-ca-production.pem"

# Also copy the real system CA bundle if available, or use a known one
if [ -f /etc/ssl/certs/ca-certificates.crt ]; then
    cat /etc/ssl/certs/ca-certificates.crt "${CERT_DIR}/ca/egress-gateway-ca-production.pem" \
        > "${CERT_DIR}/guest/ca-certificates.crt"
else
    cp "${CERT_DIR}/ca/egress-gateway-ca-production.pem" "${CERT_DIR}/guest/ca-certificates.crt"
fi

echo "==> Done: CA cert at ${CERT_DIR}/ca/egress-gateway-ca-production.pem"
echo "==> Guest bundle at ${CERT_DIR}/guest/ca-certificates.crt"
