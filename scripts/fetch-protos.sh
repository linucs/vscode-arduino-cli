#!/usr/bin/env bash
# Vendors the arduino-cli proto definitions into ./proto.
#
# The gRPC client loads these at runtime via @grpc/proto-loader, so they must
# ship with the extension (they are intentionally NOT in .gitignore).
#
# Usage: ./scripts/fetch-protos.sh [REF]   (REF defaults to the latest release tag)
set -euo pipefail

REF="${1:-master}"
BASE="https://raw.githubusercontent.com/arduino/arduino-cli/${REF}/rpc"
DEST="proto/cc/arduino/cli/commands/v1"

mkdir -p "${DEST}"

FILES=(
  commands.proto
  common.proto
  board.proto
  compile.proto
  core.proto
  lib.proto
  monitor.proto
  port.proto
  upload.proto
  debug.proto
  settings.proto
)

for f in "${FILES[@]}"; do
  echo "fetching ${f}"
  curl -fsSL "${BASE}/cc/arduino/cli/commands/v1/${f}" -o "${DEST}/${f}"
done

# commands.proto imports google/rpc/status.proto, which is part of googleapis
# (NOT bundled by @grpc/proto-loader — only google/protobuf/* is). Vendor it.
echo "fetching google/rpc/status.proto"
mkdir -p proto/google/rpc
curl -fsSL "https://raw.githubusercontent.com/googleapis/googleapis/master/google/rpc/status.proto" \
  -o proto/google/rpc/status.proto

echo "Protos vendored into ${DEST} (ref: ${REF})"
