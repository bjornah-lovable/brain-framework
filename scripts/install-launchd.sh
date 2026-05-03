#!/usr/bin/env bash
# Install (or refresh) the launchd job for scheduled brain captures.
# Idempotent — safe to run repeatedly.

set -euo pipefail

PLIST_SRC="$(cd "$(dirname "$0")" && pwd)/dev.bjorn.brain.capture.plist"
PLIST_DEST="${HOME}/Library/LaunchAgents/dev.bjorn.brain.capture.plist"

if [[ ! -f "${PLIST_SRC}" ]]; then
  echo "missing: ${PLIST_SRC}" >&2
  exit 1
fi

mkdir -p "${HOME}/Library/LaunchAgents"

# Unload first if already loaded; ignore failure.
/bin/launchctl unload "${PLIST_DEST}" 2>/dev/null || true

cp "${PLIST_SRC}" "${PLIST_DEST}"
/bin/launchctl load "${PLIST_DEST}"

echo "installed: ${PLIST_DEST}"
echo "next runs: 12:00 and 17:00 local"
