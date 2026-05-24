#!/usr/bin/env bash
#
# ╔══════════════════════════════════════════════════════════════════╗
# ║  STOP — read ~/brain/code/AGENTS.md before editing this file.    ║
# ║  Required docs: README.md, SCHEMA.md, PLAN_v3.md.                ║
# ║  Schedule + env live in scripts/dev.bjorn.brain.capture.plist —  ║
# ║  edit there, then re-run scripts/install-launchd.sh. Never       ║
# ║  hand-edit ~/Library/LaunchAgents/ directly.                     ║
# ╚══════════════════════════════════════════════════════════════════╝
#
# brain — capture worker (PLAN_v3 §3 Tier 1.5a/b/c).
#
# Runs from launchd twice a day (12:00, 17:00 Stockholm) and on demand.
# Two phases:
#
#   Phase 1 (1.5b): drain the capture-queue.jsonl. PreCompact and
#     SessionEnd hooks (capture/enqueue.sh) record events with
#     {trigger, session_id, transcript_path, cwd}. Each event triggers
#     classification of that specific session's marker..EOF delta and,
#     on CAPTURE_CREATED / QUARANTINED, a real capture write via
#     `brain-librarian capture`. Queue is rewritten to keep only events
#     that errored (so they retry next run).
#
#   Phase 2 (1.5a/c): the existing scheduled scan. Iterate every active
#     ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl, dispatch
#     classifier on any with new bytes since the last marker.
#
# Outcome values match PLAN_v3 §2.5: NO_NEW_ACTIVITY |
# NO_RELEVANT_INFORMATION | ALREADY_CAPTURED | CAPTURE_CREATED |
# QUARANTINED | ERROR. Marker advances on any non-ERROR; ERROR leaves
# the marker untouched so the next run re-processes the same bytes.

set -uo pipefail

queue_only=0
for arg in "$@"; do
  case "${arg}" in
    --queue-only) queue_only=1 ;;
  esac
done

VAULT_ROOT="${BRAIN_VAULT_ROOT:-${HOME}/brain}"
LOG_DIR="${VAULT_ROOT}/.brain/log"
STATE_DIR="${VAULT_ROOT}/.brain/state"
PAUSED_FILE="${STATE_DIR}/paused"
MARKERS_FILE="${STATE_DIR}/capture-markers.json"
ERROR_COUNTS_FILE="${STATE_DIR}/capture-error-counts.json"
QUEUE_FILE="${STATE_DIR}/capture-queue.jsonl"
# After this many consecutive ERROR outcomes on the same session, write
# a stub to .brain/needs-review/ and advance the marker past current_size.
# Stops the marker-stuck infinite-retry bleed. Different thresholds for
# semantic errors (deterministic — model can't handle this input → fail
# fast) vs spawn-empty errors (transient — Anthropic rate-limited or
# claude --bare exited silently → retry liberally across scans).
MAX_SESSION_RETRIES=1          # for unknown_outcome, missing_body_slug, librarian_cli_fail
MAX_SPAWN_EMPTY_RETRIES=5      # for spawn_empty (transient infrastructure)
# In-dispatch retries before counting toward the per-session budget.
# Handles micro-burst rate limits without burning the session's retry quota.
MAX_DISPATCH_ATTEMPTS=2
SETTINGS_BARE="${VAULT_ROOT}/.brain/settings-bare.json"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROMPT_FILE="${SCRIPT_DIR}/prompts/brain-capture-delta.md"
SCHEMA_FILE="${SCRIPT_DIR}/prompts/brain-capture-delta.schema.json"
LIBRARIAN_CLI="${BRAIN_LIBRARIAN_CLI:-${SCRIPT_DIR}/../server/dist/librarian/cli.js}"
CLAUDE_PROJECTS="${BRAIN_CLAUDE_PROJECTS:-${HOME}/.claude/projects}"
CLAUDE_BIN="${CLAUDE_BIN:-claude}"
NODE_BIN="${NODE_BIN:-${SCRIPT_DIR}/../scripts/brain-node}"

# Load model + budget + truncation defaults from .brain/config.yaml.
# The export prints KEY=VAL lines; existing env values (set by the
# caller) take precedence over the config defaults.
if config_lines="$("${NODE_BIN}" "${LIBRARIAN_CLI}" config-export 2>/dev/null)"; then
  while IFS= read -r line; do
    [[ -z "${line}" ]] && continue
    key="${line%%=*}"
    # Don't overwrite env vars the caller already set.
    if [[ -z "${!key:-}" ]]; then
      eval "export ${line}"
    fi
  done <<< "${config_lines}"
fi

DELTA_MODEL="${BRAIN_DELTA_CLASSIFIER_MODEL:-claude-sonnet-4-6}"
DELTA_MAX_BUDGET_USD="${BRAIN_DELTA_CLASSIFIER_MAX_BUDGET_USD:-0.30}"
DELTA_MAX_INPUT_BYTES="${BRAIN_DELTA_MAX_INPUT_BYTES:-524288}"

mkdir -p "${LOG_DIR}" "${STATE_DIR}"
[[ -f "${MARKERS_FILE}" ]] || echo '{}' > "${MARKERS_FILE}"
[[ -f "${QUEUE_FILE}" ]] || : > "${QUEUE_FILE}"

today="$(date +%Y-%m-%d)"
log="${LOG_DIR}/capture-${today}.log"
ts="$(date +%Y-%m-%dT%H:%M:%S%z)"

if [[ -e "${PAUSED_FILE}" ]]; then
  echo "${ts}  trigger=worker  paused=true  skipped" >> "${log}"
  exit 0
fi

# Worker-level lock: prevent concurrent capture-worker runs from
# double-processing the same session deltas. macOS doesn't ship flock,
# so use mkdir as the atomic primitive.
LOCK_DIR="${STATE_DIR}/capture-worker.lock"
if ! /bin/mkdir "${LOCK_DIR}" 2>/dev/null; then
  holder_pid=""
  if [[ -f "${LOCK_DIR}/pid" ]]; then
    holder_pid="$(/bin/cat "${LOCK_DIR}/pid" 2>/dev/null)"
  fi
  if [[ -n "${holder_pid}" ]] && /bin/ps -p "${holder_pid}" >/dev/null 2>&1; then
    echo "${ts}  trigger=worker  skipped=concurrent_run  holder_pid=${holder_pid}" >> "${log}"
    exit 0
  fi
  # Stale lock (holder no longer alive). Reclaim.
  /bin/rm -rf "${LOCK_DIR}"
  /bin/mkdir "${LOCK_DIR}"
fi
echo "$$" > "${LOCK_DIR}/pid"
trap '/bin/rm -rf "${LOCK_DIR}"' EXIT INT TERM

queue_drained=0
queue_errors=0
sessions_scanned=0
created=0
skipped=0
quarantined=0
errors=0
total_cost_usd=0
total_in_tokens=0
total_out_tokens=0
total_cache_read_tokens=0

# Exported for the python heredocs in read_marker / write_marker /
# read_error_count / write_error_count.
export MARKERS_FILE
export ERROR_COUNTS_FILE

# ---- helpers --------------------------------------------------------

read_marker() {
  BRAIN_SESSION_ID="$1" /usr/bin/python3 - <<'PY'
import json, os
path = os.environ["MARKERS_FILE"]
sid = os.environ["BRAIN_SESSION_ID"]
try:
    with open(path) as f:
        d = json.load(f)
    print(d.get(sid, 0))
except Exception:
    print(0)
PY
}

write_marker() {
  BRAIN_SESSION_ID="$1" BRAIN_OFFSET="$2" /usr/bin/python3 - <<'PY'
import json, os
path = os.environ["MARKERS_FILE"]
sid = os.environ["BRAIN_SESSION_ID"]
off = int(os.environ["BRAIN_OFFSET"])
try:
    with open(path) as f:
        d = json.load(f)
except Exception:
    d = {}
d[sid] = off
with open(path, "w") as f:
    json.dump(d, f)
PY
}

# Per-session consecutive-error counter (bleed fix). Bounded retry so
# a session whose classifier output we can't handle doesn't re-bill
# every scan forever. Reset to 0 on any non-ERROR outcome.
read_error_count() {
  BRAIN_SESSION_ID="$1" /usr/bin/python3 - <<'PY'
import json, os
path = os.environ["ERROR_COUNTS_FILE"]
sid = os.environ["BRAIN_SESSION_ID"]
try:
    with open(path) as f:
        d = json.load(f)
    print(int(d.get(sid, 0)))
except Exception:
    print(0)
PY
}

write_error_count() {
  BRAIN_SESSION_ID="$1" BRAIN_COUNT="$2" /usr/bin/python3 - <<'PY'
import json, os
path = os.environ["ERROR_COUNTS_FILE"]
sid = os.environ["BRAIN_SESSION_ID"]
n = int(os.environ["BRAIN_COUNT"])
try:
    with open(path) as f:
        d = json.load(f)
except Exception:
    d = {}
if n <= 0:
    d.pop(sid, None)
else:
    d[sid] = n
with open(path, "w") as f:
    json.dump(d, f)
PY
}

# Write a stub to .brain/needs-review/ recording the classifier
# failure so the transcript can be salvaged later if needed. The
# marker is advanced past current_size by the caller to stop the bleed.
write_quarantine_stub() {
  BRAIN_SID="$1" BRAIN_TRANSCRIPT="$2" BRAIN_MARKER="$3" BRAIN_CURRENT="$4" \
  BRAIN_LAST_RAW="$5" BRAIN_VAULT="${VAULT_ROOT}" /usr/bin/python3 - <<'PY'
import json, os
from datetime import datetime, timezone
vault = os.environ["BRAIN_VAULT"]
sid = os.environ["BRAIN_SID"]
target_dir = os.path.join(vault, ".brain", "needs-review")
os.makedirs(target_dir, exist_ok=True)
ts = datetime.now(timezone.utc).isoformat(timespec="seconds")
out = os.path.join(target_dir, f"classifier-quarantine-{sid}.md")
last_raw = os.environ.get("BRAIN_LAST_RAW","")[:1024]
body = f"""---
kind: classifier_quarantine
session_id: {sid}
transcript_path: {os.environ["BRAIN_TRANSCRIPT"]}
marker_at_quarantine: {os.environ["BRAIN_MARKER"]}
current_size_at_quarantine: {os.environ["BRAIN_CURRENT"]}
quarantined_at: {ts}
---

# Classifier quarantine: {sid}

The delta classifier produced unparseable or unknown output for this
session more than the retry budget allowed. The marker has been
advanced past `current_size` to stop the retry bleed. The transcript
file is still on disk at `transcript_path` if salvage is wanted.

## Last raw classifier output (truncated to 1KB)

```
{last_raw}
```
"""
with open(out, "w") as f:
    f.write(body)
PY
}

# Extract one field from the classifier's JSON envelope.
# Usage: parse_field <json> <field-path>
parse_field() {
  BRAIN_RAW="$1" BRAIN_FIELD="$2" /usr/bin/python3 - <<'PY'
import json, os, re, sys
raw = os.environ["BRAIN_RAW"]
field = os.environ["BRAIN_FIELD"]
try:
    d = json.loads(raw)
except Exception:
    sys.exit(0)
inner = d.get("result") if isinstance(d, dict) else None
if isinstance(inner, str):
    s = inner.strip()
    # The model occasionally wraps the JSON in a ```json … ``` fenced
    # block even under --json-schema. Strip the fence before reparsing.
    m = re.match(r"^```[a-zA-Z0-9_-]*\s*\n([\s\S]*?)\n```$", s)
    if m:
        s = m.group(1).strip()
    try:
        inner = json.loads(s)
    except Exception:
        inner = None
obj = inner if isinstance(inner, dict) else d if isinstance(d, dict) else {}
val = obj.get(field, "")
if isinstance(val, str):
    print(val)
PY
}

# Pull cost + token usage out of a `claude --bare --output-format json`
# envelope and add them to the run-level totals. Tolerates missing
# fields (e.g. the smoke-test fake omits cost). Stdin: raw envelope.
accumulate_cost() {
  local raw="$1"
  [[ -z "${raw}" ]] && return 0
  local parts
  parts="$(BRAIN_RAW="${raw}" /usr/bin/python3 - <<'PY' 2>/dev/null
import json, os
raw = os.environ.get("BRAIN_RAW", "")
try:
    d = json.loads(raw)
except Exception:
    print("0\t0\t0\t0")
    raise SystemExit
if not isinstance(d, dict):
    print("0\t0\t0\t0")
    raise SystemExit
cost = d.get("total_cost_usd") or 0
usage = d.get("usage") if isinstance(d.get("usage"), dict) else {}
in_tok = usage.get("input_tokens") or 0
out_tok = usage.get("output_tokens") or 0
cache_r = usage.get("cache_read_input_tokens") or 0
print(f"{cost}\t{in_tok}\t{out_tok}\t{cache_r}")
PY
)"
  [[ -z "${parts}" ]] && return 0
  IFS=$'\t' read -r cost in_tok out_tok cache_r <<< "${parts}"
  total_cost_usd="$(/usr/bin/python3 -c "print(f'{${total_cost_usd:-0} + ${cost:-0}:.6f}')")"
  total_in_tokens=$((total_in_tokens + ${in_tok:-0}))
  total_out_tokens=$((total_out_tokens + ${out_tok:-0}))
  total_cache_read_tokens=$((total_cache_read_tokens + ${cache_r:-0}))
}

# Build a RECENT_CAPTURES_FOR_SESSION preamble for the classifier so
# it can return ALREADY_CAPTURED when the current delta overlaps with
# content we've already captured for this same session. Dumps the
# most-recent N captures (default 10) by mtime, taking up to 800 chars
# of body each. Looks in both `captures/` (live, awaiting consolidate)
# and `.brain/processed/` (already consolidated but still indicative).
recent_captures_preamble() {
  local session_id="$1"
  local limit="${2:-10}"
  local max_chars="${3:-800}"
  BRAIN_SESSION_ID="${session_id}" \
  BRAIN_LIMIT="${limit}" \
  BRAIN_MAX_CHARS="${max_chars}" \
  BRAIN_CAPTURES_DIR="${VAULT_ROOT}/captures" \
  BRAIN_PROCESSED_DIR="${VAULT_ROOT}/.brain/processed" \
  /usr/bin/python3 - <<'PY'
import os
from pathlib import Path

sid = os.environ["BRAIN_SESSION_ID"]
limit = int(os.environ["BRAIN_LIMIT"])
max_chars = int(os.environ["BRAIN_MAX_CHARS"])
roots = [
    Path(os.environ["BRAIN_CAPTURES_DIR"]),
    Path(os.environ["BRAIN_PROCESSED_DIR"]),
]

candidates = []
for root in roots:
    if not root.is_dir():
        continue
    for p in root.glob(f"session-{sid}-*.md"):
        try:
            candidates.append((p.stat().st_mtime, p))
        except OSError:
            continue

candidates.sort(reverse=True)  # most recent first
chosen = candidates[:limit]
chosen.reverse()  # render oldest-first so the classifier sees a timeline

if not chosen:
    print("(no prior captures for this session)")
else:
    for mtime, path in chosen:
        try:
            body = path.read_text(encoding="utf8")
        except OSError:
            continue
        if len(body) > max_chars:
            body = body[:max_chars] + "\n...[truncated]"
        print(f"--- {path.name} ---")
        print(body)
        print()
PY
}

# Filter raw Claude Code transcript JSONL down to just the conversation:
# human-typed user messages and assistant text replies. Tool calls,
# tool results, attachments, file-history snapshots, custom-title /
# agent-name / permission-mode metadata records, and any other non-text
# record types are dropped. Stdin: raw JSONL bytes. Stdout: plain
# text blocks prefixed with "[user]:" / "[assistant]:" separated by
# blank lines.
#
# Why: the classifier only needs the conversation to decide what to
# capture. Sending raw JSONL with tool noise wastes tokens AND tends
# to push the model into off-schema output (probable cause:
# instruction-shaped content in tool results competing with the
# classifier prompt).
filter_transcript_to_conversation() {
  /usr/bin/python3 - <<'PY'
import json, sys

# User content that's just a wrapped tooling tag — Claude Code's
# !-shell-command artefacts, system reminders, slash-command names,
# task notifications, hook output — isn't a human message. Keeping
# these confuses the classifier (it tries to respond to the most
# recent tag instead of producing the schema JSON).
TOOLING_TAG_PREFIXES = (
    "<bash-input>", "<bash-stdout>", "<bash-stderr>",
    "<system-reminder>", "<local-command-caveat>",
    "<command-name>", "<command-message>", "<command-args>",
    "<task-notification>",
)

def is_tooling_string(s):
    s = s.lstrip()
    return any(s.startswith(p) for p in TOOLING_TAG_PREFIXES)

def collect_texts(content, drop_tooling=False):
    """Return a list of text strings from a message.content value.
    If drop_tooling=True (user records), skip strings that are
    just wrapped Claude-Code tooling tags."""
    out = []
    if isinstance(content, str):
        if content.strip() and not (drop_tooling and is_tooling_string(content)):
            out.append(content)
    elif isinstance(content, list):
        for item in content:
            if isinstance(item, dict) and item.get("type") == "text":
                t = item.get("text", "")
                if isinstance(t, str) and t.strip() and not (drop_tooling and is_tooling_string(t)):
                    out.append(t)
    return out

# Read stdin as bytes so a tail-cut that lands inside a multi-byte
# UTF-8 character doesn't crash the filter. Decode each line
# individually with replacement; unparseable lines (partial first
# line after the cut, malformed records) are skipped silently.
raw = sys.stdin.buffer.read()
for line_bytes in raw.split(b"\n"):
    try:
        line = line_bytes.decode("utf-8", errors="replace").strip()
    except Exception:
        continue
    if not line:
        continue
    try:
        d = json.loads(line)
    except Exception:
        continue
    t = d.get("type", "")
    if t not in ("user", "assistant"):
        continue
    msg = d.get("message")
    if not isinstance(msg, dict):
        continue
    texts = collect_texts(msg.get("content"), drop_tooling=(t == "user"))
    if not texts:
        # type=user with only tool_result / tooling tags, or assistant
        # with only tool_use / thinking, etc.
        continue
    print(f"[{t}]: " + "\n".join(s.strip() for s in texts))
    print()
PY
}

# Run the classifier against a JSONL tail. Prints raw classifier
# stdout to stdout. Returns non-zero on spawn failure.
# Usage: run_classifier <jsonl-path> <marker-offset> <trigger> <ctx-json> <session-id>
run_classifier() {
  local jsonl="$1"
  local marker="$2"
  local trigger="$3"
  local ctx="$4"
  local session_id="$5"
  # file_size is passed in by the caller (which also stats it for the
  # marker write) so the bytes the classifier sees and the bytes the
  # marker advances past are the same span — no race against an
  # actively-being-written transcript. Falls back to a fresh stat if
  # not provided (compat with older callers).
  local file_size="${6:-}"
  if [[ -z "${file_size}" ]]; then
    file_size=$(/usr/bin/stat -f%z "${jsonl}" 2>/dev/null || /usr/bin/stat -c%s "${jsonl}" 2>/dev/null || echo 0)
  fi

  local settings_args=()
  if [[ -f "${SETTINGS_BARE}" ]]; then
    settings_args+=(--settings "${SETTINGS_BARE}")
  fi

  local schema_args=()
  if [[ -f "${SCHEMA_FILE}" ]]; then
    # Inline the schema rather than passing the path; --json-schema
    # accepts inline JSON.
    local schema
    schema="$(/bin/cat "${SCHEMA_FILE}")"
    schema_args+=(--json-schema "${schema}")
  fi

  # Compute delta size and apply optional truncation. Cap of 0 means
  # unbounded (used by one-time cold-start runs over big sessions).
  local delta_size start_offset truncation_note=""
  delta_size=$((file_size - marker))
  start_offset=$((marker + 1))
  if [[ "${DELTA_MAX_INPUT_BYTES}" -gt 0 && "${delta_size}" -gt "${DELTA_MAX_INPUT_BYTES}" ]]; then
    start_offset=$((file_size - DELTA_MAX_INPUT_BYTES + 1))
    truncation_note="[NOTE: transcript delta is ${delta_size} bytes; truncated to last ${DELTA_MAX_INPUT_BYTES} bytes for classifier. Older session content is not visible to this classification.]"
  fi

  # Materialize the prompt once so we can replay it on transient
  # spawn-empty failures without re-running the filter pipeline.
  local prompt_tmp out_tmp err_tmp
  prompt_tmp=$(/usr/bin/mktemp -t brain-prompt) || return 1
  out_tmp=$(/usr/bin/mktemp -t brain-out) || { /bin/rm -f "${prompt_tmp}"; return 1; }
  err_tmp=$(/usr/bin/mktemp -t brain-err) || { /bin/rm -f "${prompt_tmp}" "${out_tmp}"; return 1; }
  {
    /bin/cat "${PROMPT_FILE}"
    echo
    echo "---"
    echo
    echo "CONTEXT_JSON: ${ctx}"
    if [[ -n "${truncation_note}" ]]; then
      echo
      echo "${truncation_note}"
    fi
    echo
    echo "RECENT_CAPTURES_FOR_SESSION:"
    recent_captures_preamble "${session_id}"
    echo
    echo "TRANSCRIPT_DELTA:"
    # Bound output to delta_size bytes. The filter strips tool noise
    # / metadata records so the classifier only sees the conversation
    # (see filter_transcript_to_conversation).
    if [[ "${delta_size}" -gt 0 ]]; then
      /usr/bin/tail -c "+${start_offset}" "${jsonl}" | /usr/bin/head -c "${delta_size}" | filter_transcript_to_conversation
    fi
  } > "${prompt_tmp}"

  # Try up to MAX_DISPATCH_ATTEMPTS times. claude --bare sometimes exits
  # with empty stdout AND empty stderr under rate-limit / transient
  # bursts — observed in the 2026-05-24 scan, 26 such failures in 3 min.
  # Sleep 1s between attempts.
  local attempt=1 rc=0
  while [[ "${attempt}" -le "${MAX_DISPATCH_ATTEMPTS}" ]]; do
    : > "${out_tmp}"
    : > "${err_tmp}"
    BRAIN_INTERNAL=1 "${CLAUDE_BIN}" \
      --bare \
      -p \
      --model "${DELTA_MODEL}" \
      --tools "" \
      --no-session-persistence \
      --max-turns 1 \
      --max-budget-usd "${DELTA_MAX_BUDGET_USD}" \
      --output-format json \
      "${schema_args[@]+"${schema_args[@]}"}" \
      "${settings_args[@]+"${settings_args[@]}"}" \
      < "${prompt_tmp}" > "${out_tmp}" 2> "${err_tmp}"
    rc=$?
    if [[ -s "${out_tmp}" ]]; then
      break
    fi
    # Empty stdout — record what we know for diagnosis, then retry.
    {
      printf '%s  session=%s attempt=%d rc=%d stdout=0 stderr_bytes=%d\n' \
        "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        "${session_id}" \
        "${attempt}" \
        "${rc}" \
        "$(/usr/bin/stat -f%z "${err_tmp}" 2>/dev/null || echo 0)"
      if [[ -s "${err_tmp}" ]]; then
        echo "--- stderr ---"
        /bin/cat "${err_tmp}"
        echo "--- /stderr ---"
      fi
    } >> "${LOG_DIR}/spawn-errors-$(date +%Y-%m-%d).log"
    attempt=$((attempt + 1))
    if [[ "${attempt}" -le "${MAX_DISPATCH_ATTEMPTS}" ]]; then
      /bin/sleep 1
    fi
  done

  /bin/cat "${out_tmp}"
  /bin/rm -f "${prompt_tmp}" "${out_tmp}" "${err_tmp}"
  return "${rc}"
}

# Success path for any non-ERROR outcome: advance marker AND reset
# the per-session consecutive-error counter.
success_path() {
  local session_id="$1"
  local new_marker="$2"
  write_marker "${session_id}" "${new_marker}"
  write_error_count "${session_id}" 0
}

# Error path: increment the per-session consecutive-error counter.
# If we've exceeded MAX_SESSION_RETRIES, write a quarantine stub to
# .brain/needs-review/, advance the marker past current_size to stop
# the bleed, and reset the counter. Otherwise leave the marker alone
# (the next run retries).
#
# Writes a structured diagnostic line to
# .brain/log/classifier-errors-YYYY-MM-DD.log so we can later analyse
# which failure mode is firing. err_type is one of:
#   spawn_empty           — claude --bare returned no stdout at all
#   unknown_outcome       — outcome field empty or unrecognised
#   missing_body_slug     — outcome=CAPTURE_CREATED|QUARANTINED but body/slug empty
#   librarian_cli_fail    — librarian capture CLI returned non-zero
note_session_error() {
  local session_id="$1"
  local transcript_path="$2"
  local marker_before="$3"
  local current_size="$4"
  local raw="$5"
  local err_type="${6:-unspecified}"

  BRAIN_SID="${session_id}" BRAIN_ERR="${err_type}" BRAIN_RAW="${raw}" \
  BRAIN_LOG="${LOG_DIR}/classifier-errors-$(date +%Y-%m-%d).log" \
  /usr/bin/python3 - <<'PY' 2>/dev/null || true
import json, os, re
from datetime import datetime, timezone
raw = os.environ.get("BRAIN_RAW", "")
out = {
  "ts": datetime.now(timezone.utc).isoformat(timespec="seconds"),
  "session": os.environ["BRAIN_SID"],
  "err_type": os.environ["BRAIN_ERR"],
  "raw_len": len(raw),
}
# Try to extract result + parsed outcome
try:
    env = json.loads(raw) if raw else {}
except Exception:
    env = {}
out["envelope_subtype"] = env.get("subtype") if isinstance(env, dict) else None
out["envelope_terminal_reason"] = env.get("terminal_reason") if isinstance(env, dict) else None
out["envelope_stop_reason"] = env.get("stop_reason") if isinstance(env, dict) else None
out["envelope_cost"] = env.get("total_cost_usd") if isinstance(env, dict) else None
result = env.get("result", "") if isinstance(env, dict) else ""
out["result_len"] = len(result) if isinstance(result, str) else 0
out["result_first_300"] = (result[:300] if isinstance(result, str) else str(result)[:300])
# Try to parse the inner JSON
if isinstance(result, str) and result.strip():
    s = result.strip()
    m = re.match(r"^```[a-zA-Z0-9_-]*\s*\n([\s\S]*?)\n```$", s)
    if m: s = m.group(1).strip()
    try:
        p = json.loads(s)
        if isinstance(p, dict):
            out["parsed_outcome"] = p.get("outcome")
            out["parsed_body_len"] = len(p.get("body") or "") if isinstance(p.get("body"), str) else 0
            out["parsed_slug"] = p.get("project_slug")
            out["parsed_kind"] = p.get("capture_kind")
            out["parsed_confidence_type"] = type(p.get("confidence")).__name__
            out["parsed_importance"] = p.get("importance")
    except Exception as e:
        out["inner_parse_error"] = str(e)[:120]
with open(os.environ["BRAIN_LOG"], "a") as f:
    f.write(json.dumps(out) + "\n")
PY

  local count threshold
  count=$(read_error_count "${session_id}")
  count=$((count + 1))

  # spawn_empty is transient infra (rate limit, silent CLI exit); allow
  # many cross-scan retries before quarantining. Semantic errors are
  # deterministic — fail fast.
  if [[ "${err_type}" == "spawn_empty" ]]; then
    threshold="${MAX_SPAWN_EMPTY_RETRIES}"
  else
    threshold="${MAX_SESSION_RETRIES}"
  fi

  if [[ "${count}" -gt "${threshold}" ]]; then
    write_quarantine_stub "${session_id}" "${transcript_path}" \
      "${marker_before}" "${current_size}" "${raw}"
    write_marker "${session_id}" "${current_size}"
    write_error_count "${session_id}" 0
    quarantined=$((quarantined + 1))
  else
    write_error_count "${session_id}" "${count}"
    errors=$((errors + 1))
  fi
}

# Apply a classifier outcome to one session: write the capture if any,
# advance the marker if non-ERROR, otherwise count toward the retry
# budget and quarantine if exhausted. Updates the global counters.
# Usage: apply_outcome <raw> <session-id> <new-marker> <trigger> <transcript-path> <marker-before>
apply_outcome() {
  local raw="$1"
  local session_id="$2"
  local new_marker="$3"
  local trigger="$4"
  local transcript_path="${5:-}"
  local marker_before="${6:-0}"

  local outcome
  outcome="$(parse_field "${raw}" outcome)"

  case "${outcome}" in
    NO_NEW_ACTIVITY|NO_RELEVANT_INFORMATION|ALREADY_CAPTURED)
      skipped=$((skipped + 1))
      success_path "${session_id}" "${new_marker}"
      return 0
      ;;
    CAPTURE_CREATED|QUARANTINED)
      local body slug kind importance confidence capture_input cli_out
      body="$(parse_field "${raw}" body)"
      slug="$(parse_field "${raw}" project_slug)"
      kind="$(parse_field "${raw}" capture_kind)"
      importance="$(parse_field "${raw}" importance)"
      confidence="$(parse_field "${raw}" confidence)"

      if [[ -z "${body}" || -z "${slug}" ]]; then
        # Schema violation — body and slug are required for these outcomes.
        note_session_error "${session_id}" "${transcript_path}" \
          "${marker_before}" "${new_marker}" "${raw}" "missing_body_slug"
        return 0
      fi

      capture_input="$(BRAIN_BODY="${body}" BRAIN_SLUG="${slug}" \
        BRAIN_TRIGGER="${trigger}" BRAIN_SESSION_ID="${session_id}" \
        BRAIN_KIND="${kind}" BRAIN_IMPORTANCE="${importance}" \
        BRAIN_CONFIDENCE="${confidence}" \
        /usr/bin/python3 - <<'PY'
import json, os
inp = {
  "body": os.environ["BRAIN_BODY"],
  "project_slug": os.environ["BRAIN_SLUG"],
  "trigger": os.environ["BRAIN_TRIGGER"],
  "session_id": os.environ["BRAIN_SESSION_ID"],
}
for k, env in (
  ("capture_kind", "BRAIN_KIND"),
  ("importance", "BRAIN_IMPORTANCE"),
  ("confidence", "BRAIN_CONFIDENCE"),
):
  v = os.environ.get(env, "")
  if v:
    inp[k] = v
print(json.dumps(inp))
PY
)"

      if cli_out="$(echo "${capture_input}" | "${NODE_BIN}" "${LIBRARIAN_CLI}" capture 2>/dev/null)"; then
        local was_quarantined
        was_quarantined="$(/usr/bin/python3 - "${cli_out}" <<'PY'
import json, sys
try:
    d = json.loads(sys.argv[1])
    print("yes" if d.get("quarantined") else "no")
except Exception:
    print("no")
PY
)"
        if [[ "${was_quarantined}" == "yes" || "${outcome}" == "QUARANTINED" ]]; then
          quarantined=$((quarantined + 1))
        else
          created=$((created + 1))
        fi
        success_path "${session_id}" "${new_marker}"
      else
        note_session_error "${session_id}" "${transcript_path}" \
          "${marker_before}" "${new_marker}" "${raw}" "librarian_cli_fail"
      fi
      return 0
      ;;
    *)
      note_session_error "${session_id}" "${transcript_path}" \
        "${marker_before}" "${new_marker}" "${raw}" "unknown_outcome"
      return 1
      ;;
  esac
}

# Track session_ids attempted in phase 1 so phase 2 won't re-classify
# them in the same run. Bash arrays as a poor-man's set; lookup is
# O(N) but N is small (~queue size, typically <50).
declare -a phase1_attempted=()

phase1_already_attempted() {
  local needle="$1"
  local s
  # `${arr[@]+"${arr[@]}"}` keeps `set -u` happy when the array is
  # empty (macOS bash 3.2). Without it, an empty queue → empty array
  # → unbound-variable crash before phase 2 can do anything.
  for s in "${phase1_attempted[@]+"${phase1_attempted[@]}"}"; do
    [[ "${s}" == "${needle}" ]] && return 0
  done
  return 1
}

# ---- phase 1: drain queue -------------------------------------------

if [[ -s "${QUEUE_FILE}" ]]; then
  # Snapshot the queue so concurrent enqueues don't get clobbered.
  queue_tmp="${QUEUE_FILE}.draining.$$"
  /bin/mv "${QUEUE_FILE}" "${queue_tmp}"
  : > "${QUEUE_FILE}"

  while IFS= read -r event; do
    [[ -z "${event}" ]] && continue
    queue_drained=$((queue_drained + 1))

    session_id="$(/usr/bin/python3 -c "import json,sys; print(json.loads(sys.argv[1]).get('session_id',''))" "${event}" 2>/dev/null || echo "")"
    transcript_path="$(/usr/bin/python3 -c "import json,sys; print(json.loads(sys.argv[1]).get('transcript_path',''))" "${event}" 2>/dev/null || echo "")"
    trigger="$(/usr/bin/python3 -c "import json,sys; print(json.loads(sys.argv[1]).get('trigger','queued'))" "${event}" 2>/dev/null || echo queued)"

    if [[ -z "${session_id}" || -z "${transcript_path}" || ! -f "${transcript_path}" ]]; then
      # Best-effort: missing or unreadable transcript → log + drop.
      queue_errors=$((queue_errors + 1))
      continue
    fi

    if [[ ! -f "${PROMPT_FILE}" ]]; then
      # Re-enqueue: the classifier prompt isn't ready yet; preserve event.
      echo "${event}" >> "${QUEUE_FILE}"
      queue_errors=$((queue_errors + 1))
      continue
    fi

    current_size=$(/usr/bin/stat -f%z "${transcript_path}" 2>/dev/null || /usr/bin/stat -c%s "${transcript_path}" 2>/dev/null || echo 0)
    marker="$(read_marker "${session_id}")"

    if [[ "${current_size}" -le "${marker}" ]]; then
      # Nothing new since last classification — count as skip.
      skipped=$((skipped + 1))
      # Mark attempted so phase 2 doesn't re-stat-and-skip the same
      # session (cheap, but avoids a second-trip log line).
      phase1_attempted+=("${session_id}")
      continue
    fi

    # Mark BEFORE the classifier call. Even on error/requeue we don't
    # want phase 2 to re-pay for the same delta in the same run.
    phase1_attempted+=("${session_id}")

    ctx="$(BRAIN_CTX="${event}" /usr/bin/python3 -c "import json,os; print(json.dumps(json.loads(os.environ['BRAIN_CTX'])))")"
    raw="$(run_classifier "${transcript_path}" "${marker}" "${trigger}" "${ctx}" "${session_id}" "${current_size}")" || raw=""
    if [[ -z "${raw}" ]]; then
      # Spawn / classifier failure — count toward the retry budget so
      # repeated spawn-fails don't bleed forever via re-enqueue.
      note_session_error "${session_id}" "${transcript_path}" \
        "${marker}" "${current_size}" "" "spawn_empty"
      continue
    fi
    accumulate_cost "${raw}"
    apply_outcome "${raw}" "${session_id}" "${current_size}" "${trigger}" \
      "${transcript_path}" "${marker}" || :
  done < "${queue_tmp}"

  /bin/rm -f "${queue_tmp}"
fi

if [[ "${queue_only}" == 1 ]]; then
  echo "${ts}  trigger=worker  queue_only=1  queue_drained=${queue_drained}  queue_errors=${queue_errors}  created=${created}  skipped=${skipped}  quarantined=${quarantined}  errors=${errors}  cost_usd=${total_cost_usd}  in_tokens=${total_in_tokens}  out_tokens=${total_out_tokens}  cache_read_tokens=${total_cache_read_tokens}" >> "${log}"
  exit 0
fi

# ---- phase 2: scheduled scan ---------------------------------------

shopt -s nullglob
for jsonl in "${CLAUDE_PROJECTS}"/*/*.jsonl; do
  sessions_scanned=$((sessions_scanned + 1))
  session_id="$(/usr/bin/basename "${jsonl}" .jsonl)"
  if [[ -z "${session_id}" ]]; then
    errors=$((errors + 1))
    continue
  fi

  # Phase-1 already touched this session in this run (drained or
  # error'd). Skip — re-classifying here either re-pays the same LLM
  # cost or re-races the marker.
  if phase1_already_attempted "${session_id}"; then
    continue
  fi

  current_size=$(/usr/bin/stat -f%z "${jsonl}" 2>/dev/null || /usr/bin/stat -c%s "${jsonl}" 2>/dev/null || echo 0)
  marker="$(read_marker "${session_id}")"

  if [[ "${current_size}" -le "${marker}" ]]; then
    skipped=$((skipped + 1))
    continue
  fi

  if [[ ! -f "${PROMPT_FILE}" ]]; then
    errors=$((errors + 1))
    continue
  fi

  raw="$(run_classifier "${jsonl}" "${marker}" "scheduled" '{"trigger":"scheduled"}' "${session_id}" "${current_size}")" || raw=""
  if [[ -z "${raw}" ]]; then
    note_session_error "${session_id}" "${jsonl}" \
      "${marker}" "${current_size}" "" "spawn_empty"
    continue
  fi
  accumulate_cost "${raw}"
  apply_outcome "${raw}" "${session_id}" "${current_size}" "scheduled" \
    "${jsonl}" "${marker}" || :
done

echo "${ts}  trigger=worker  queue_drained=${queue_drained}  queue_errors=${queue_errors}  sessions_scanned=${sessions_scanned}  created=${created}  skipped=${skipped}  quarantined=${quarantined}  errors=${errors}  cost_usd=${total_cost_usd}  in_tokens=${total_in_tokens}  out_tokens=${total_out_tokens}  cache_read_tokens=${total_cache_read_tokens}" >> "${log}"
