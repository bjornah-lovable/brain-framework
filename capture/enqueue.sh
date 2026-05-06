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

# Dedup before append: a single CC session can fire SessionEnd /
# PreCompact multiple times during one work block, and the worker pays
# 4 python subprocesses per duplicate event before bailing on the
# marker check. Drop earlier events for the same (session_id,
# transcript_path) and keep this one as the latest.
BRAIN_NEW_EVENT="${event}" BRAIN_QUEUE="${QUEUE_FILE}" /usr/bin/python3 - <<'PY'
import json, os, tempfile
queue_path = os.environ["BRAIN_QUEUE"]
new = json.loads(os.environ["BRAIN_NEW_EVENT"])
key_fields = ("session_id", "transcript_path")
new_key = tuple(new.get(k, "") for k in key_fields)

kept = []
try:
    with open(queue_path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                e = json.loads(line)
            except Exception:
                kept.append(line)
                continue
            if tuple(e.get(k, "") for k in key_fields) == new_key:
                continue  # superseded by new event
            kept.append(line)
except FileNotFoundError:
    pass

kept.append(json.dumps(new))

# Atomic write via tmp + rename so concurrent hooks don't lose lines.
fd, tmp_path = tempfile.mkstemp(
    dir=os.path.dirname(queue_path), prefix=".queue.", suffix=".tmp"
)
with os.fdopen(fd, "w") as f:
    f.write("\n".join(kept) + "\n")
os.rename(tmp_path, queue_path)
PY

exit 0
