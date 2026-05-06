#!/usr/bin/env bash
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

VAULT_ROOT="${BRAIN_VAULT_ROOT:-${HOME}/brain}"
LOG_DIR="${VAULT_ROOT}/.brain/log"
STATE_DIR="${VAULT_ROOT}/.brain/state"
PAUSED_FILE="${STATE_DIR}/paused"
MARKERS_FILE="${STATE_DIR}/capture-markers.json"
QUEUE_FILE="${STATE_DIR}/capture-queue.jsonl"
SETTINGS_BARE="${VAULT_ROOT}/.brain/settings-bare.json"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROMPT_FILE="${SCRIPT_DIR}/prompts/brain-capture-delta.md"
SCHEMA_FILE="${SCRIPT_DIR}/prompts/brain-capture-delta.schema.json"
LIBRARIAN_CLI="${BRAIN_LIBRARIAN_CLI:-${SCRIPT_DIR}/../server/dist/librarian/cli.js}"
CLAUDE_PROJECTS="${BRAIN_CLAUDE_PROJECTS:-${HOME}/.claude/projects}"
CLAUDE_BIN="${CLAUDE_BIN:-claude}"
NODE_BIN="${NODE_BIN:-node}"

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

# Exported for the python heredocs in read_marker / write_marker.
export MARKERS_FILE

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

# Extract one field from the classifier's JSON envelope.
# Usage: parse_field <json> <field-path>
parse_field() {
  BRAIN_RAW="$1" BRAIN_FIELD="$2" /usr/bin/python3 - <<'PY'
import json, os, sys
raw = os.environ["BRAIN_RAW"]
field = os.environ["BRAIN_FIELD"]
try:
    d = json.loads(raw)
except Exception:
    sys.exit(0)
inner = d.get("result") if isinstance(d, dict) else None
if isinstance(inner, str):
    try:
        inner = json.loads(inner)
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
    # Bound output to delta_size bytes. If the file grows between
    # the caller's stat and tail-execution, those extra bytes don't
    # leak into the classifier — the next run picks them up.
    if [[ "${delta_size}" -gt 0 ]]; then
      /usr/bin/tail -c "+${start_offset}" "${jsonl}" | /usr/bin/head -c "${delta_size}"
    fi
  } | BRAIN_INTERNAL=1 "${CLAUDE_BIN}" \
      --bare \
      -p \
      --model "${DELTA_MODEL}" \
      --tools "" \
      --no-session-persistence \
      --max-turns 1 \
      --max-budget-usd "${DELTA_MAX_BUDGET_USD}" \
      --output-format json \
      "${schema_args[@]+"${schema_args[@]}"}" \
      "${settings_args[@]+"${settings_args[@]}"}" 2> >(/usr/bin/tee -a "${LOG_DIR}/spawn-errors-$(date +%Y-%m-%d).log" >&2)
  local rc=$?
  # rc !=0 here is informational — the parent already treats empty
  # stdout as a spawn failure. We just want a breadcrumb in the log
  # when stderr was non-empty (e.g. "command not found", auth fail).
  return ${rc}
}

# Apply a classifier outcome to one session: write the capture if any,
# advance the marker if non-ERROR. Updates the global counters.
# Usage: apply_outcome <classifier-raw-stdout> <session-id> <new-marker> <trigger>
apply_outcome() {
  local raw="$1"
  local session_id="$2"
  local new_marker="$3"
  local trigger="$4"

  local outcome
  outcome="$(parse_field "${raw}" outcome)"

  case "${outcome}" in
    NO_NEW_ACTIVITY|NO_RELEVANT_INFORMATION|ALREADY_CAPTURED)
      skipped=$((skipped + 1))
      write_marker "${session_id}" "${new_marker}"
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
        errors=$((errors + 1))
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
        write_marker "${session_id}" "${new_marker}"
      else
        errors=$((errors + 1))
      fi
      return 0
      ;;
    *)
      errors=$((errors + 1))
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
  for s in "${phase1_attempted[@]}"; do
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
      # Spawn / classifier failure — re-enqueue for next run.
      echo "${event}" >> "${QUEUE_FILE}"
      queue_errors=$((queue_errors + 1))
      continue
    fi
    accumulate_cost "${raw}"
    if ! apply_outcome "${raw}" "${session_id}" "${current_size}" "${trigger}"; then
      echo "${event}" >> "${QUEUE_FILE}"
      queue_errors=$((queue_errors + 1))
    fi
  done < "${queue_tmp}"

  /bin/rm -f "${queue_tmp}"
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
    errors=$((errors + 1))
    continue
  fi
  accumulate_cost "${raw}"
  apply_outcome "${raw}" "${session_id}" "${current_size}" "scheduled" || :
done

echo "${ts}  trigger=worker  queue_drained=${queue_drained}  queue_errors=${queue_errors}  sessions_scanned=${sessions_scanned}  created=${created}  skipped=${skipped}  quarantined=${quarantined}  errors=${errors}  cost_usd=${total_cost_usd}  in_tokens=${total_in_tokens}  out_tokens=${total_out_tokens}  cache_read_tokens=${total_cache_read_tokens}" >> "${log}"
