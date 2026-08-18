#!/usr/bin/env bash
set -euo pipefail

NODE_VERSION="${SOCKETAGENT_NODE_VERSION:-22.22.1}"
ARCH="$(uname -m)"

case "$ARCH" in
  x86_64) NODE_ARCH="x64" ;;
  aarch64|arm64) NODE_ARCH="arm64" ;;
  *)
    echo "Unsupported architecture: $ARCH" >&2
    exit 1
    ;;
esac

NODE_DIR="/usr/local/lib/nodejs/node-v${NODE_VERSION}-linux-${NODE_ARCH}"

if [[ ! -x "$NODE_DIR/bin/node" ]]; then
  tmp="/tmp/node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz"
  curl -fSL --retry 3 --connect-timeout 15 \
    -o "$tmp" \
    "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz"
  rm -rf "$NODE_DIR"
  mkdir -p "$NODE_DIR"
  tar -xJf "$tmp" -C "$NODE_DIR" --strip-components=1
  rm -f "$tmp"
fi

ln -sf "$NODE_DIR/bin/node" /usr/local/bin/node
ln -sf "$NODE_DIR/bin/npm" /usr/local/bin/npm
ln -sf "$NODE_DIR/bin/npx" /usr/local/bin/npx

node --version
npm --version
