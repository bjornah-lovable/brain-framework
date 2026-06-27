#!/usr/bin/env bash
#
# ╔══════════════════════════════════════════════════════════════════╗
# ║  STOP — read ~/brain/code/AGENTS.md before editing this script.  ║
# ║  Plists live at scripts/<label>.plist. Add new plists there,     ║
# ║  list them in install_one() below, run this. Never hand-write    ║
# ║  to ~/Library/LaunchAgents/ — re-running this script overwrites  ║
# ║  hand-edits and other machines never see them.                   ║
# ╚══════════════════════════════════════════════════════════════════╝
#
# Install (or refresh) the launchd jobs for the brain auto-loop.
# Idempotent — safe to run repeatedly.
#
# Jobs:
#   dev.bjorn.brain.capture-queue — hourly (XX:30) queue drain only.
#                                   Processes PreCompact/SessionEnd hook
#                                   events from capture-queue.jsonl so the
#                                   just-closed session is searchable in
#                                   the next CC session, without paying
#                                   the full scheduled-scan cost 24×/day.
#   dev.bjorn.brain.capture       — twice-daily (12:00 + 17:00) classifier
#                                   worker. Drains the queue (idempotent
#                                   no-op if the hourly job got there
#                                   first), then runs the scheduled scan
#                                   over every active CC session JSONL.
#   dev.bjorn.brain.synthesize    — daily (18:00) `consolidate --synthesize`
#                                   that absorbs captures into project
#                                   pages with Opus-rewritten block prose.

set -euo pipefail

SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
DEST_DIR="${HOME}/Library/LaunchAgents"
mkdir -p "${DEST_DIR}"

install_one() {
  local label="$1"
  local src="${SRC_DIR}/${label}.plist"
  local dest="${DEST_DIR}/${label}.plist"

  if [[ ! -f "${src}" ]]; then
    echo "missing: ${src}" >&2
    return 1
  fi

  /bin/launchctl unload "${dest}" 2>/dev/null || true
  cp "${src}" "${dest}"
  /bin/launchctl load "${dest}"
  echo "installed: ${dest}"
}

install_one "dev.bjorn.brain.capture-queue"
install_one "dev.bjorn.brain.capture"
install_one "dev.bjorn.brain.synthesize"
install_one "dev.bjorn.brain.cleanup"
install_one "dev.bjorn.brain.recent"

echo
echo "schedule:"
echo "  cleanup            11:00 + 16:00 local (lint: stale traces + truncated-fallback bullets)"
echo "  capture queue      XX:30 hourly        (drain SessionEnd/PreCompact hook events only)"
echo "  capture worker     12:00 + 17:00 local (queue drain + scheduled scan over all active sessions)"
echo "  synthesize         18:00 local daily   (Opus rewrite of affected blocks)"
echo "  recent             18:15 local daily   (aggregate project Recent updates into ~/brain/recent.md)"
