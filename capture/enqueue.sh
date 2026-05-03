#!/usr/bin/env bash
# brain — capture queue enqueue (PLAN_v3 §3 Tier 1.5b).
#
# Hook helper for PreCompact and SessionEnd command-type hooks.
# Reads the hook input JSON from stdin and appends one event line to
# ~/brain/.brain/state/capture-queue.jsonl. The brain-capture worker
# drains this queue at the next launchd run (or when invoked manually).
#
# This is a write-only path: hooks always succeed regardless of whether
# the MCP server, the classifier prompt, or `claude` is available.
# Durability of the trigger is what matters; processing is async.
#
# Invocation: enqueue.sh <trigger>
#   trigger ∈ {pre_compact, session_end, manual}.
#
# Always exits 0 — never block a CC hook on this.

set -uo pipefail

VAULT_ROOT="${BRAIN_VAULT_ROOT:-${HOME}/brain}"
STATE_DIR="${VAULT_ROOT}/.brain/state"
QUEUE_FILE="${STATE_DIR}/capture-queue.jsonl"
TRIGGER="${1:-manual}"

mkdir -p "${STATE_DIR}"

# Hook input is JSON on stdin. Extract session_id, transcript_path, cwd
# defensively; missing fields are recorded as empty strings.
input="$(cat 2>/dev/null || echo '{}')"

event="$(BRAIN_INPUT="${input}" BRAIN_TRIGGER="${TRIGGER}" /usr/bin/python3 - <<'PY'
import json, os
from datetime import datetime, timezone

raw = os.environ.get("BRAIN_INPUT", "{}")
trigger = os.environ.get("BRAIN_TRIGGER", "manual")

try:
    d = json.loads(raw) if raw.strip() else {}
except Exception:
    d = {}

session_id = d.get("session_id") or ""
transcript_path = d.get("transcript_path") or ""
cwd = d.get("cwd") or ""
reason = d.get("reason") or ""

event = {
  "trigger": trigger,
  "session_id": session_id,
  "transcript_path": transcript_path,
  "cwd": cwd,
  "reason": reason,
  "created_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
}
print(json.dumps(event))
PY
)"

# Atomic append: locked_file_append in bash terms is just `>>`. JSONL
# is line-atomic so concurrent enqueues from parallel hooks don't tear.
echo "${event}" >> "${QUEUE_FILE}"
exit 0
