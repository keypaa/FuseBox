#!/usr/bin/env bash
set -euo pipefail

KERNEL_VERSION="6.18.5"
KERNEL_URL="https://git.kernel.org/pub/scm/linux/kernel/git/stable/linux.git/snapshot/linux-${KERNEL_VERSION}.tar.gz"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BUILD_DIR="${SCRIPT_DIR}/build"

if [ -f "${SCRIPT_DIR}/vmlinux" ]; then
    echo "==> vmlinux already exists, skipping kernel build."
    ls -lh "${SCRIPT_DIR}/vmlinux"
    exit 0
fi

echo "==> Downloading Linux ${KERNEL_VERSION}..."
mkdir -p "${BUILD_DIR}"
cd "${BUILD_DIR}"

if [ ! -f "linux-${KERNEL_VERSION}/Makefile" ]; then
    curl -L "${KERNEL_URL}" -o "linux-${KERNEL_VERSION}.tar.gz"
    tar xzf "linux-${KERNEL_VERSION}.tar.gz"
fi

cd "linux-${KERNEL_VERSION}"

echo "==> Applying microvm kernel config..."
cp "${SCRIPT_DIR}/microvm.config" .config
make olddefconfig

echo "==> Building kernel (this takes a while)..."
make -j"$(nproc)" vmlinux

echo "==> Copying vmlinux..."
cp vmlinux "${SCRIPT_DIR}/vmlinux"

echo "==> Done: ${SCRIPT_DIR}/vmlinux"
ls -lh "${SCRIPT_DIR}/vmlinux"
