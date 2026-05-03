#!/usr/bin/env bash
# Tier-1 smoke test for the brain MCP server. Local-only; no real
# `claude` invocations (so no LLM costs); does not modify
# ~/.claude/settings.json.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SERVER="${ROOT}/server/dist/index.js"

if [[ ! -f "${SERVER}" ]]; then
  echo "build first: pnpm build" >&2
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required" >&2
  exit 1
fi

# Run against an isolated tempdir vault by default — keeps the live
# ~/brain free of smoke-test artefacts (test slugs, dupe bullets,
# half-processed captures). Override with BRAIN_SMOKE_VAULT=<path> to
# point at an existing vault (e.g. for debugging a real-vault issue).
if [[ -n "${BRAIN_SMOKE_VAULT:-}" ]]; then
  VAULT="${BRAIN_SMOKE_VAULT}"
  SMOKE_VAULT_OWNED=0
else
  VAULT="$(mktemp -d -t brain-smoke-vault.XXXXXX)"
  SMOKE_VAULT_OWNED=1
fi
export BRAIN_VAULT_ROOT="${VAULT}"

cleanup_smoke_vault() {
  if [[ "${SMOKE_VAULT_OWNED}" == "1" && -n "${VAULT}" && -d "${VAULT}" ]]; then
    rm -rf "${VAULT}"
  fi
}
trap cleanup_smoke_vault EXIT

# Seed the minimal vault structure the checks rely on. The MCP server
# falls back to config defaults if .brain/config.yaml is missing, so
# we don't seed one — defaults give twice_daily cadence, tier 1.
mkdir -p "${VAULT}/profile" \
         "${VAULT}/projects" \
         "${VAULT}/feed" \
         "${VAULT}/knowledge/topics" \
         "${VAULT}/raw/articles" \
         "${VAULT}/raw/imports" \
         "${VAULT}/captures" \
         "${VAULT}/.brain/state" \
         "${VAULT}/.brain/log" \
         "${VAULT}/.brain/db" \
         "${VAULT}/.brain/lock" \
         "${VAULT}/.brain/processed" \
         "${VAULT}/.brain/needs-review" \
         "${VAULT}/.brain/search/runs" \
         "${VAULT}/.brain/provenance"

printf '# Smoke test profile\n' > "${VAULT}/profile/me.md"
echo '{}' > "${VAULT}/.brain/state/capture-markers.json"
: > "${VAULT}/.brain/state/capture-queue.jsonl"

CAPTURE_PRE_COUNT="$(/bin/ls "${VAULT}/captures" 2>/dev/null | wc -l | tr -d ' ')"

mcp() {
  # mcp <method> <params-json> [<call-name>]
  local method="$1"
  local params="$2"
  local name="${3:-}"
  local req
  if [[ "${method}" == "tools/call" ]]; then
    req='{"jsonrpc":"2.0","id":99,"method":"tools/call","params":{"name":"'"${name}"'","arguments":'"${params}"'}}'
  else
    req='{"jsonrpc":"2.0","id":99,"method":"'"${method}"'","params":'"${params}"'}'
  fi
  printf '%s\n%s\n%s\n' \
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' \
    '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
    "${req}" \
    | BRAIN_VAULT_ROOT="${VAULT}" node "${SERVER}" 2>/dev/null \
    | tail -n 1
}

echo "--- 1. tools/list ---"
n=$(mcp "tools/list" '{}' | jq '.result.tools | length')
echo "  tool_count=${n}  (expected 11)"
[[ "${n}" == "11" ]] || { echo "FAIL"; exit 1; }

echo "--- 2. brain-status ---"
mcp "tools/call" '{}' "brain-status" \
  | jq -r '.result.content[0].text | fromjson | "  vault=\(.vault_root) cadence=\(.capture.cadence) tier=\(.tier)"'

echo "--- 3. brain-capture (manual write) ---"
mcp "tools/call" \
    '{"body":"## Findings\n- Smoke-test capture; brain pipeline confirmed end-to-end.","project_slug":"second-brain","trigger":"manual","capture_kind":"finding"}' \
    "brain-capture" \
  | jq -r '.result.content[0].text | fromjson | "  wrote=" + (.path | split("/") | last)'

echo "--- 4. brain-read profile/me.md ---"
mcp "tools/call" '{"path":"profile/me.md"}' "brain-read" \
  | jq -r '.result.content[0].text | fromjson | "  exists=\(.exists) bytes=\(.size_bytes // 0)"'

echo "--- 5. brain-search depth=fast returns kind=dossier ---"
mcp "tools/call" \
    '{"query":"smoke test","depth":"fast","scope":["captures"]}' \
    "brain-search" \
  | jq -r '.result.content[0].text | fromjson | "  kind=\(.kind) sources=\(.dossier.sources | length) confidence=\(.dossier.confidence)"'

echo "--- 6. brain-read PATH_TRAVERSAL rejected ---"
mcp "tools/call" '{"path":"../../etc/passwd"}' "brain-read" \
  | jq -r '.result.content[0].text | fromjson | "  error_code=\(.error.code)"'

mkdir -p /tmp/brain-smoke && echo "TOKEN=hunter2" > /tmp/brain-smoke/.env
echo "--- 7. brain-ingest .env rejected ---"
mcp "tools/call" '{"source_path":"/tmp/brain-smoke/.env"}' "brain-ingest" \
  | jq -r '.result.content[0].text | fromjson | "  error_code=\(.error.code)"'
rm -rf /tmp/brain-smoke

echo "--- 8. sacred-paths-guard exit 2 on Write to projects/ ---"
out=$(echo '{"tool_name":"Write","tool_input":{"file_path":"'"${VAULT}"'/projects/test.md","content":"x"}}' \
       | "${ROOT}/hooks/sacred-paths-guard.sh" 2>&1; echo "exit=$?")
[[ "${out}" == *"refusing"* ]] && [[ "${out}" == *"exit=2"* ]] && echo "  blocked OK (exit=2)" || { echo "  FAIL: ${out}"; exit 1; }

echo "--- 9. sacred-paths-guard exit 2 on Bash redirect to projects/ ---"
out=$(echo '{"tool_name":"Bash","tool_input":{"command":"echo y > '"${VAULT}"'/projects/x.md"}}' \
       | "${ROOT}/hooks/sacred-paths-guard.sh" 2>&1; echo "exit=$?")
[[ "${out}" == *"refusing"* ]] && [[ "${out}" == *"exit=2"* ]] && echo "  blocked OK (exit=2)" || { echo "  FAIL: ${out}"; exit 1; }

echo "--- 10. sacred-paths-guard allows Bash read of projects/ ---"
out=$(echo '{"tool_name":"Bash","tool_input":{"command":"cat '"${VAULT}"'/projects/x.md"}}' \
       | "${ROOT}/hooks/sacred-paths-guard.sh" 2>&1; echo "exit=$?")
[[ "${out}" == *"exit=0"* ]] && echo "  allowed-read OK" || { echo "  FAIL: ${out}"; exit 1; }

echo "--- 11. sacred-paths-guard allows /tmp Write ---"
out=$(echo '{"tool_name":"Write","tool_input":{"file_path":"/tmp/x.md","content":"x"}}' \
       | "${ROOT}/hooks/sacred-paths-guard.sh" 2>&1; echo "exit=$?")
[[ "${out}" == *"exit=0"* ]] && echo "  allowed-outside OK" || { echo "  FAIL: ${out}"; exit 1; }

echo "--- 12. brain-capture quarantines on secret pattern ---"
mcp "tools/call" \
    '{"body":"## Findings\n- Captured AKIAEXAMPLE12345ABCD in a stack trace.\n","project_slug":"second-brain","trigger":"manual"}' \
    "brain-capture" \
  | jq -r '.result.content[0].text | fromjson | "  quarantined=\(.quarantined) patterns=\(.secret_patterns_matched // [] | join(","))"'

echo "--- 13. brain-status surfaces active sessions + needs_review ---"
mcp "tools/call" '{}' "brain-status" \
  | jq -r '.result.content[0].text | fromjson | "  needs_review=\(.capture.needs_review) active_sessions_24h=\(.active_sessions_24h | length)"'

echo "--- 14. brain-librarian-plan-synthesis (parent-dispatch) ---"
# Drop a real capture under a fresh slug, call plan-synthesis through
# MCP. Verifies plan persistence + pending_synthesis shape with prompt
# + schema. No LLM spawned.
SYNTH_CAPTURE="${VAULT}/captures/session-smoke-pd-$(date +%s).md"
cat > "${SYNTH_CAPTURE}" <<EOF
---
session_id: smoke-pd
created_at: $(date -u +%Y-%m-%dT%H:%M:%SZ)
trigger: manual
project_slug: brain-pdtest
capture_kind: finding
---
## Findings
- Parent-dispatch smoke test capture; the planner should defer this group as one pending_synthesis task.
EOF

PLAN_OUT="$(mcp "tools/call" '{}' "brain-librarian-plan-synthesis")"
PLAN_ID="$(echo "${PLAN_OUT}" | jq -r '.result.content[0].text | fromjson | .plan_id')"
PD_PENDING="$(echo "${PLAN_OUT}" | jq -c '.result.content[0].text | fromjson | .pending_synthesis[] | select(.project_slug == "brain-pdtest")')"
PENDING_BLOCK="$(echo "${PD_PENDING}" | jq -r '.block_id // ""')"
PROMPT_LEN="$(echo "${PD_PENDING}" | jq -r '.prompt | length')"
echo "  plan_id=${PLAN_ID:0:12}... pending_block=${PENDING_BLOCK} prompt_len=${PROMPT_LEN}"
[[ -n "${PLAN_ID}" && "${PLAN_ID}" != "null" && "${PENDING_BLOCK}" == "project.brain-pdtest.recent-updates.v1" ]] \
  || { echo "  FAIL"; exit 1; }

echo "--- 15. brain-librarian-apply-synthesis (parent results round-trip) ---"
# Hand-craft a valid SynthesisOutput as if a Task subagent produced it.
APPLY_RESULTS=$(jq -nc --arg blk "${PENDING_BLOCK}" '{
  results: [{
    block_id: $blk,
    output: {
      new_block_body: ("## Recent updates\n<!-- brain:block " + $blk + " -->\n\n- 2026-05-03 — Parent-dispatch smoke verified end-to-end: planner returned pending_synthesis, applier rewrote the block.\n"),
      summary: "Parent-dispatch smoke test that round-trips plan→apply through the MCP without LLM cost.",
      aliases: ["parent dispatch smoke", "Task subagent flow"],
      entities: ["brain-librarian-plan-synthesis", "brain-librarian-apply-synthesis"],
      search_terms: ["parent-dispatch round-trip", "plan-apply protocol"]
    }
  }]
}')
APPLY_INPUT=$(jq -nc --arg pid "${PLAN_ID}" --argjson r "${APPLY_RESULTS}" '{plan_id:$pid} + $r')
APPLY_OUT="$(mcp "tools/call" "${APPLY_INPUT}" "brain-librarian-apply-synthesis")"
echo "${APPLY_OUT}" | jq -r --arg blk "${PENDING_BLOCK}" '.result.content[0].text | fromjson | "  ok=\(.ok) consolidated=\(.consolidated) target_method=\([.per_block[] | select(.block_id == $blk) | .method] | first)"'
echo "${APPLY_OUT}" | jq -e --arg blk "${PENDING_BLOCK}" '.result.content[0].text | fromjson | .ok == true and ([.per_block[] | select(.block_id == $blk) | .method] | first) == "synthesized"' >/dev/null \
  || { echo "  FAIL"; exit 1; }

echo "--- 16. blocks_meta_fts indexed; alias-only query hits via metadata FTS ---"
mcp "tools/call" \
    '{"query":"parent-dispatch round-trip","depth":"fast","scope":["projects"]}' \
    "brain-search" \
  | jq -r '.result.content[0].text | fromjson | "  kind=\(.kind) sources=\(.dossier.sources | length) reasons=\([.dossier.sources[].why_relevant] | join(","))"'

echo "--- 16a. index.md regenerated by apply-synthesis ---"
# After 15 ran, the librarian should have rewritten ~/brain/index.md
# (or rather, the smoke vault's index.md) with at least the
# brain-pdtest project listed under ## Projects.
INDEX_PATH="${VAULT}/index.md"
if [[ ! -f "${INDEX_PATH}" ]]; then
  echo "  FAIL: ${INDEX_PATH} missing"; exit 1
fi
INDEX_HAS_HEADING=$(grep -c "^## Projects" "${INDEX_PATH}" || true)
INDEX_HAS_PDTEST=$(grep -c "brain-pdtest" "${INDEX_PATH}" || true)
echo "  projects_heading=${INDEX_HAS_HEADING} pdtest_listed=${INDEX_HAS_PDTEST}"
[[ "${INDEX_HAS_HEADING}" -ge 1 && "${INDEX_HAS_PDTEST}" -ge 1 ]] \
  || { echo "  FAIL: index.md not regenerated"; exit 1; }

if [[ "${BRAIN_USE_HEADLESS_CLAUDE:-}" != "1" ]]; then
echo "--- 16b. brain-search depth=standard returns kind=pending_dispatch (parent-dispatch default) ---"
PD_OUT="$(mcp "tools/call" '{"query":"parent-dispatch","depth":"standard","scope":["projects"]}' "brain-search")"
PD_KIND="$(echo "${PD_OUT}" | jq -r '.result.content[0].text | fromjson | .kind')"
PD_SEARCH_ID="$(echo "${PD_OUT}" | jq -r '.result.content[0].text | fromjson | .search_id')"
echo "  kind=${PD_KIND} search_id=${PD_SEARCH_ID:0:8}..."
[[ "${PD_KIND}" == "pending_dispatch" ]] || { echo "  FAIL"; exit 1; }

echo "--- 16c. brain-search-finalize records parent-supplied dossier ---"
FINALIZE_DOSSIER=$(jq -nc '{
  query_interpretation: "round-trip test for finalize",
  answer: "ok",
  confidence: "low",
  sources: [],
  suggested_reads: [],
  open_questions: []
}')
FIN_INPUT=$(jq -nc --arg sid "${PD_SEARCH_ID}" --argjson d "${FINALIZE_DOSSIER}" '{search_id:$sid, dossier:$d}')
FIN_OUT="$(mcp "tools/call" "${FIN_INPUT}" "brain-search-finalize")"
echo "${FIN_OUT}" | jq -r '.result.content[0].text | fromjson | "  ok=\(.ok) trace=\(.trace_path | split("/") | last)"'
echo "${FIN_OUT}" | jq -e '.result.content[0].text | fromjson | .ok == true' >/dev/null \
  || { echo "  FAIL"; exit 1; }

echo "--- 16d. brain-search-finalize SCHEMA_INVALID on a fresh pending dispatch ---"
# Spin up a fresh pending_dispatch so we can hit the schema-invalid path
# before the trace is finalized. Query matches the page rewritten in 15
# so we get non-empty candidates → kind=pending_dispatch.
PD2_OUT="$(mcp "tools/call" '{"query":"parent-dispatch round-trip","depth":"standard","scope":["projects"]}' "brain-search")"
PD2_SEARCH_ID="$(echo "${PD2_OUT}" | jq -r '.result.content[0].text | fromjson | .search_id // ""')"
[[ -n "${PD2_SEARCH_ID}" ]] || { echo "  FAIL: no search_id from pending_dispatch ${PD2_OUT}"; exit 1; }
BAD=$(jq -nc --arg sid "${PD2_SEARCH_ID}" '{search_id:$sid, dossier:{not:"a dossier"}}')
BAD_OUT="$(mcp "tools/call" "${BAD}" "brain-search-finalize")"
echo "${BAD_OUT}" | jq -r '.result.content[0].text | fromjson | "  ok=\(.ok) error_code=\(.error.code // "")"'
echo "${BAD_OUT}" | jq -e '.result.content[0].text | fromjson | .ok == false and .error.code == "SCHEMA_INVALID"' >/dev/null \
  || { echo "  FAIL: ${BAD_OUT}"; exit 1; }
fi  # end !headless gate

if [[ "${BRAIN_USE_HEADLESS_CLAUDE:-}" == "1" ]]; then
  echo "--- 16e. headless consolidate --synthesize via fake CLAUDE_BIN (BRAIN_USE_HEADLESS_CLAUDE=1) ---"
  HCAP="${VAULT}/captures/session-smoke-headless-$(date +%s).md"
  cat > "${HCAP}" <<EOF
---
session_id: smoke-headless
created_at: $(date -u +%Y-%m-%dT%H:%M:%SZ)
trigger: manual
project_slug: brain-headless
capture_kind: finding
---
## Findings
- Headless-path smoke; should only fire when BRAIN_USE_HEADLESS_CLAUDE=1.
EOF
  HOUT="$(BRAIN_VAULT_ROOT="${VAULT}" BRAIN_USE_HEADLESS_CLAUDE=1 \
          CLAUDE_BIN="${ROOT}/scripts/fake-claude-synthesizer.sh" \
          BRAIN_FAKE_SLUG=brain-headless \
          BRAIN_FAKE_BLOCK_ID=project.brain-headless.recent-updates.v1 \
          node "${ROOT}/server/dist/librarian/cli.js" consolidate --synthesize)"
  echo "  ${HOUT}" | jq -r '"  scanned=\(.scanned) consolidated=\(.consolidated) method=\([.synthesis[].method] | join(","))"'
fi

echo "--- 17. brain-capture.sh marker scan: NO_NEW_ACTIVITY skip ---"
# Build a fake projects dir with one jsonl whose marker is already at
# its current size. Script should report skipped=1, no LLM call.
FAKE_PROJ="$(mktemp -d -t brain-capture-smoke.XXXXXX)/projects"
mkdir -p "${FAKE_PROJ}/encoded-cwd"
FAKE_JSONL="${FAKE_PROJ}/encoded-cwd/smoke-session-noop.jsonl"
echo '{"role":"system","content":"already-seen"}' > "${FAKE_JSONL}"
SIZE=$(/usr/bin/stat -f%z "${FAKE_JSONL}" 2>/dev/null || /usr/bin/stat -c%s "${FAKE_JSONL}")
# Pre-seed marker at current size so the script sees no new bytes.
/usr/bin/python3 - "${VAULT}/.brain/state/capture-markers.json" smoke-session-noop "${SIZE}" <<'PY'
import json, sys
path, sid, off = sys.argv[1], sys.argv[2], int(sys.argv[3])
try:
    with open(path) as f:
        d = json.load(f)
except Exception:
    d = {}
d[sid] = off
with open(path, "w") as f:
    json.dump(d, f)
PY
BRAIN_VAULT_ROOT="${VAULT}" BRAIN_CLAUDE_PROJECTS="${FAKE_PROJ}" \
  "${ROOT}/capture/brain-capture.sh"
LAST_LINE="$(/usr/bin/tail -n 1 "${VAULT}/.brain/log/capture-$(date +%Y-%m-%d).log")"
echo "  log_tail: ${LAST_LINE}"
[[ "${LAST_LINE}" == *"sessions_scanned=1"* && "${LAST_LINE}" == *"skipped=1"* && "${LAST_LINE}" == *"errors=0"* ]] \
  && echo "  NO_NEW_ACTIVITY OK" || { echo "  FAIL"; exit 1; }

echo "--- 18. brain-capture.sh marker NOT advanced when classifier spawn fails ---"
# Append bytes so the dispatch fires; point CLAUDE_BIN at /bin/false so
# the spawn exits non-zero. Marker should stay at the original SIZE.
echo '{"role":"user","content":"new"}' >> "${FAKE_JSONL}"
BRAIN_VAULT_ROOT="${VAULT}" BRAIN_CLAUDE_PROJECTS="${FAKE_PROJ}" \
  CLAUDE_BIN=/bin/false \
  "${ROOT}/capture/brain-capture.sh"
LAST_LINE="$(/usr/bin/tail -n 1 "${VAULT}/.brain/log/capture-$(date +%Y-%m-%d).log")"
echo "  log_tail: ${LAST_LINE}"
[[ "${LAST_LINE}" == *"errors=1"* && "${LAST_LINE}" == *"created=0"* ]] \
  && echo "  ERROR-on-spawn-failure OK" || { echo "  FAIL"; exit 1; }
MARKER_NOW="$(/usr/bin/python3 -c "
import json
d = json.load(open('${VAULT}/.brain/state/capture-markers.json'))
print(d.get('smoke-session-noop', -1))
")"
[[ "${MARKER_NOW}" == "${SIZE}" ]] \
  && echo "  marker not advanced on ERROR OK" || { echo "  FAIL marker=${MARKER_NOW} expected=${SIZE}"; exit 1; }

echo "--- 19. delta classifier CAPTURE_CREATED → capture file lands ---"
# Fake classifier returns a CAPTURE_CREATED dossier; expect a real
# capture file in ~/brain/captures/.
: > "${VAULT}/.brain/state/capture-queue.jsonl"
PRE_CAPS=$(/bin/ls "${VAULT}/captures" 2>/dev/null | wc -l | tr -d ' ')
BRAIN_VAULT_ROOT="${VAULT}" BRAIN_CLAUDE_PROJECTS="${FAKE_PROJ}" \
  CLAUDE_BIN="${ROOT}/scripts/fake-claude-delta-classifier.sh" \
  BRAIN_FAKE_SLUG=smoke-delta \
  BRAIN_FAKE_DELTA_OUTCOME=CAPTURE_CREATED \
  "${ROOT}/capture/brain-capture.sh"
LAST_LINE="$(/usr/bin/tail -n 1 "${VAULT}/.brain/log/capture-$(date +%Y-%m-%d).log")"
echo "  log_tail: ${LAST_LINE}"
POST_CAPS=$(/bin/ls "${VAULT}/captures" 2>/dev/null | wc -l | tr -d ' ')
[[ $((POST_CAPS - PRE_CAPS)) -ge 1 && "${LAST_LINE}" == *"errors=0"* ]] \
  && echo "  capture file landed OK" \
  || { echo "  FAIL captures: ${PRE_CAPS} -> ${POST_CAPS} log=${LAST_LINE}"; exit 1; }

echo "--- 20. delta classifier NO_RELEVANT_INFORMATION → marker advances, no capture ---"
# Fresh delta + classifier returns "skip"; capture count unchanged,
# marker advances to current size.
: > "${VAULT}/.brain/state/capture-queue.jsonl"
echo '{"role":"user","content":"another nothing-burger"}' >> "${FAKE_JSONL}"
NEW_SIZE=$(/usr/bin/stat -f%z "${FAKE_JSONL}" 2>/dev/null || /usr/bin/stat -c%s "${FAKE_JSONL}")
PRE_CAPS=$(/bin/ls "${VAULT}/captures" 2>/dev/null | wc -l | tr -d ' ')
BRAIN_VAULT_ROOT="${VAULT}" BRAIN_CLAUDE_PROJECTS="${FAKE_PROJ}" \
  CLAUDE_BIN="${ROOT}/scripts/fake-claude-delta-classifier.sh" \
  BRAIN_FAKE_DELTA_OUTCOME=NO_RELEVANT_INFORMATION \
  "${ROOT}/capture/brain-capture.sh"
LAST_LINE="$(/usr/bin/tail -n 1 "${VAULT}/.brain/log/capture-$(date +%Y-%m-%d).log")"
echo "  log_tail: ${LAST_LINE}"
POST_CAPS=$(/bin/ls "${VAULT}/captures" 2>/dev/null | wc -l | tr -d ' ')
MARKER_NOW="$(/usr/bin/python3 -c "
import json
d = json.load(open('${VAULT}/.brain/state/capture-markers.json'))
print(d.get('smoke-session-noop', -1))
")"
[[ $((POST_CAPS - PRE_CAPS)) -eq 0 && "${MARKER_NOW}" == "${NEW_SIZE}" ]] \
  && echo "  no capture, marker advanced OK" \
  || { echo "  FAIL captures: ${PRE_CAPS} -> ${POST_CAPS} marker=${MARKER_NOW} expected=${NEW_SIZE}"; exit 1; }

echo "--- 21. enqueue.sh + queue drain via brain-capture.sh ---"
# Fresh delta on a new fake session; drop a queue event via enqueue.sh
# pointing at it; run the worker; queue should be empty afterwards
# and a capture should have been created.
: > "${VAULT}/.brain/state/capture-queue.jsonl"
JSONL2="${FAKE_PROJ}/encoded-cwd/smoke-session-queued.jsonl"
echo '{"role":"user","content":"queued event content"}' > "${JSONL2}"
# Pre-clean any persistent marker from previous runs so this is a
# truly fresh classification (capture-markers.json is operational
# state and persists across smoke invocations when the vault is
# real, but with the tempdir default the file is fresh anyway).
/usr/bin/python3 - "${VAULT}/.brain/state/capture-markers.json" <<'PY'
import json, sys
p = sys.argv[1]
try:
    d = json.load(open(p))
except Exception:
    d = {}
d.pop("smoke-session-queued", None)
json.dump(d, open(p, "w"))
PY
# Use enqueue.sh as if invoked by a PreCompact hook.
echo "{\"session_id\":\"smoke-session-queued\",\"transcript_path\":\"${JSONL2}\",\"cwd\":\"/tmp\",\"reason\":\"smoke\"}" \
  | "${ROOT}/capture/enqueue.sh" pre_compact
QSIZE_BEFORE=$(wc -l < "${VAULT}/.brain/state/capture-queue.jsonl" | tr -d ' ')
[[ "${QSIZE_BEFORE}" == "1" ]] || { echo "  FAIL: queue size after enqueue = ${QSIZE_BEFORE}"; exit 1; }
PRE_CAPS=$(/bin/ls "${VAULT}/captures" 2>/dev/null | wc -l | tr -d ' ')
BRAIN_VAULT_ROOT="${VAULT}" BRAIN_CLAUDE_PROJECTS="${FAKE_PROJ}" \
  CLAUDE_BIN="${ROOT}/scripts/fake-claude-delta-classifier.sh" \
  BRAIN_FAKE_SLUG=smoke-queue \
  BRAIN_FAKE_DELTA_OUTCOME=CAPTURE_CREATED \
  "${ROOT}/capture/brain-capture.sh"
QSIZE_AFTER=$(wc -l < "${VAULT}/.brain/state/capture-queue.jsonl" | tr -d ' ')
LAST_LINE="$(/usr/bin/tail -n 1 "${VAULT}/.brain/log/capture-$(date +%Y-%m-%d).log")"
echo "  log_tail: ${LAST_LINE}"
POST_CAPS=$(/bin/ls "${VAULT}/captures" 2>/dev/null | wc -l | tr -d ' ')
[[ "${QSIZE_AFTER}" == "0" && "${LAST_LINE}" == *"queue_drained=1"* && $((POST_CAPS - PRE_CAPS)) -ge 1 ]] \
  && echo "  queue drained, capture written OK" \
  || { echo "  FAIL queue=${QSIZE_AFTER} captures=${PRE_CAPS}->${POST_CAPS}"; exit 1; }

echo "--- 21a. classifier sees RECENT_CAPTURES_FOR_SESSION → ALREADY_CAPTURED ---"
# Drop a prior capture for a session, then classify a fresh delta
# against that same session. The fake classifier (in
# REQUIRES_CAPTURES mode) detects the non-empty preamble and
# overrides its outcome to ALREADY_CAPTURED. Expectation: skipped++,
# no capture file written, marker still advances.
: > "${VAULT}/.brain/state/capture-queue.jsonl"
JSONL_AC="${FAKE_PROJ}/encoded-cwd/smoke-already-captured.jsonl"
echo '{"role":"user","content":"covered by an earlier manual capture"}' > "${JSONL_AC}"
# Drop a prior capture for the same session_id.
PRIOR_CAP="${VAULT}/captures/session-smoke-already-captured-9000000000.md"
cat > "${PRIOR_CAP}" <<'EOF'
---
session_id: smoke-already-captured
created_at: '2026-05-03T00:00:00Z'
trigger: manual
project_slug: brain-already
---
## Findings
- We already captured this earlier — ALREADY_CAPTURED should win on the next classify.
EOF
PRE_AC_COUNT=$(/usr/bin/find "${VAULT}/captures" -maxdepth 1 -name 'session-smoke-already-captured-*.md' 2>/dev/null | wc -l | tr -d ' ')
BRAIN_VAULT_ROOT="${VAULT}" BRAIN_CLAUDE_PROJECTS="${FAKE_PROJ}" \
  CLAUDE_BIN="${ROOT}/scripts/fake-claude-delta-classifier.sh" \
  BRAIN_FAKE_DELTA_OUTCOME=CAPTURE_CREATED \
  BRAIN_FAKE_DELTA_REQUIRES_CAPTURES=1 \
  BRAIN_FAKE_SLUG=brain-already \
  "${ROOT}/capture/brain-capture.sh"
LAST_LINE="$(/usr/bin/tail -n 1 "${VAULT}/.brain/log/capture-$(date +%Y-%m-%d).log")"
echo "  log_tail: ${LAST_LINE}"
POST_AC_COUNT=$(/usr/bin/find "${VAULT}/captures" -maxdepth 1 -name 'session-smoke-already-captured-*.md' 2>/dev/null | wc -l | tr -d ' ')
# The prior capture we dropped should still be there; no NEW capture
# for this session should have been written. Other test sessions in
# the same FAKE_PROJ are not relevant — the assertion checks ours
# specifically.
[[ "${POST_AC_COUNT}" == "${PRE_AC_COUNT}" && "${LAST_LINE}" == *"errors=0"* ]] \
  && echo "  ALREADY_CAPTURED honoured (no new capture for this session)" \
  || { echo "  FAIL prior=${PRE_AC_COUNT} after=${POST_AC_COUNT}, log: ${LAST_LINE}"; exit 1; }
# Cleanup the prior capture only. We deliberately leave the marker
# advanced so 21b's scheduled scan treats this session as fully
# consumed and doesn't reclassify the same delta — that would muddy
# 21b's accounting.
rm -f "${PRIOR_CAP}"

echo "--- 21b. brain-capture.sh delta truncation on oversize input ---"
# Build a JSONL whose size > BRAIN_DELTA_MAX_INPUT_BYTES; assert the
# classifier was still dispatched and a capture landed (truncation
# kicked in instead of error).
: > "${VAULT}/.brain/state/capture-queue.jsonl"
# Pre-advance markers for all *existing* fake sessions so the scheduled
# scan only fires on the bigdelta file we're about to drop. Without
# this the scan picks up any sessions whose markers drifted in earlier
# checks and classifies them too — which would inflate `created`.
/usr/bin/python3 - "${FAKE_PROJ}/encoded-cwd" "${VAULT}/.brain/state/capture-markers.json" <<'PY'
import json, os, sys
proj_dir, markers_path = sys.argv[1], sys.argv[2]
try:
    markers = json.load(open(markers_path))
except Exception:
    markers = {}
for f in os.listdir(proj_dir):
    if not f.endswith(".jsonl"):
        continue
    sid = f[:-len(".jsonl")]
    markers[sid] = os.path.getsize(os.path.join(proj_dir, f))
json.dump(markers, open(markers_path, "w"))
PY
JSONL_BIG="${FAKE_PROJ}/encoded-cwd/smoke-session-bigdelta.jsonl"
# 200 KB of dummy JSONL lines.
BRAIN_OUT_PATH="${JSONL_BIG}" /usr/bin/python3 - <<'PY'
import json, os
p = os.environ["BRAIN_OUT_PATH"]
filler = "lorem ipsum dolor sit amet " * 4
with open(p, "w") as f:
    for i in range(2000):
        f.write(json.dumps({"role": "assistant", "content": f"line {i} - {filler}"}) + "\n")
PY
# Truncate cap to 50 KB so the 200 KB delta is well over.
PRE_CAPS=$(/bin/ls "${VAULT}/captures" 2>/dev/null | wc -l | tr -d ' ')
BRAIN_VAULT_ROOT="${VAULT}" BRAIN_CLAUDE_PROJECTS="${FAKE_PROJ}" \
  CLAUDE_BIN="${ROOT}/scripts/fake-claude-delta-classifier.sh" \
  BRAIN_FAKE_SLUG=smoke-bigdelta \
  BRAIN_FAKE_DELTA_OUTCOME=CAPTURE_CREATED \
  BRAIN_DELTA_MAX_INPUT_BYTES=50000 \
  "${ROOT}/capture/brain-capture.sh"
LAST_LINE="$(/usr/bin/tail -n 1 "${VAULT}/.brain/log/capture-$(date +%Y-%m-%d).log")"
echo "  log_tail: ${LAST_LINE}"
POST_CAPS=$(/bin/ls "${VAULT}/captures" 2>/dev/null | wc -l | tr -d ' ')
[[ "${LAST_LINE}" == *"created=1"* && $((POST_CAPS - PRE_CAPS)) -ge 1 ]] \
  && echo "  oversized delta truncated and classified OK" \
  || { echo "  FAIL"; exit 1; }
# Cleanup the bigdelta marker so subsequent runs aren't confused.
/usr/bin/python3 -c "
import json
p = '${VAULT}/.brain/state/capture-markers.json'
d = json.load(open(p))
d.pop('smoke-session-bigdelta', None)
json.dump(d, open(p, 'w'))
"

# Cleanup capture files written by 19 + 21 + 21b
/usr/bin/find "${VAULT}/captures" -name 'session-smoke-session-noop-*.md' -delete 2>/dev/null || true
/usr/bin/find "${VAULT}/captures" -name 'session-smoke-session-queued-*.md' -delete 2>/dev/null || true
/usr/bin/find "${VAULT}/captures" -name 'session-smoke-session-bigdelta-*.md' -delete 2>/dev/null || true

# Cleanup test fixtures and the smoke marker entries.
rm -rf "$(dirname "${FAKE_PROJ}")"
/usr/bin/python3 -c "
import json
p = '${VAULT}/.brain/state/capture-markers.json'
d = json.load(open(p))
for sid in ['smoke-session-noop','smoke-session-queued','smoke-session-bigdelta']:
    d.pop(sid, None)
json.dump(d, open(p, 'w'))
"

echo "--- 22. import-pointers creates pointer pages from a fake projects/ tree ---"
FAKE_PROJ_SRC="$(mktemp -d -t brain-import-smoke.XXXXXX)/projects"
mkdir -p "${FAKE_PROJ_SRC}/imp-fixture-2026-04-09"
cat > "${FAKE_PROJ_SRC}/imp-fixture-2026-04-09/meta.yaml" <<EOF
project: imp-fixture-2026-04-09
created: 2026-04-09
status: active
owner: bjorn
prefix: imp
summary: |
  Smoke fixture for import-pointers: should produce a brain pointer
  page at projects/imp-fixture.md with the right frontmatter.
linear: ['EVALS-999 # smoke fixture comment']
prs: []
notion: []
slack_threads: []
depends_on: []
tags: [smoke, fixture]
EOF
cat > "${FAKE_PROJ_SRC}/imp-fixture-2026-04-09/README.md" <<EOF
# imp-fixture
Most recent state: smoke fixture. The importer should pull this into the where-we-are block once plan-imports + apply runs.

## Open
- One open question that exercises the blockers section.
EOF
mkdir -p "${FAKE_PROJ_SRC}/imp-fixture-2026-04-09/notes"
echo "- 2026-04-09 — initial framing of smoke fixture." > "${FAKE_PROJ_SRC}/imp-fixture-2026-04-09/notes/2026-04-09-initial.md"
mkdir -p "${FAKE_PROJ_SRC}/_template"  # should be skipped

# Pre-clean: ensure no leftover imp-fixture page from previous runs.
rm -f "${VAULT}/projects/imp-fixture.md" 2>/dev/null
rm -f "${VAULT}/.brain/provenance/projects/imp-fixture.json" 2>/dev/null

IMP_OUT="$(BRAIN_VAULT_ROOT="${VAULT}" BRAIN_PROJECTS_SOURCE="${FAKE_PROJ_SRC}" \
  node "${ROOT}/server/dist/librarian/cli.js" import-pointers --source "${FAKE_PROJ_SRC}")"
echo "${IMP_OUT}" | jq -r '"  scanned=\(.scanned) created=\(.created | length) skipped=\(.skipped | length) collisions=\(.collisions | length) errors=\(.errors | length)"'
[[ -f "${VAULT}/projects/imp-fixture.md" ]] || { echo "  FAIL: imp-fixture.md not created"; exit 1; }
echo "${IMP_OUT}" | jq -e '.created[0].slug == "imp-fixture" and (.scanned == 1)' >/dev/null \
  || { echo "  FAIL"; exit 1; }
echo "  pointer page OK"

echo "--- 23. import-pointers re-run is a no-op (already_present) ---"
IMP_OUT2="$(BRAIN_VAULT_ROOT="${VAULT}" BRAIN_PROJECTS_SOURCE="${FAKE_PROJ_SRC}" \
  node "${ROOT}/server/dist/librarian/cli.js" import-pointers --source "${FAKE_PROJ_SRC}")"
echo "${IMP_OUT2}" | jq -r '"  created=\(.created | length) skipped=\(.skipped | length)"'
echo "${IMP_OUT2}" | jq -e '(.created | length) == 0 and (.skipped | length) == 1' >/dev/null \
  || { echo "  FAIL"; exit 1; }
echo "  idempotent OK"

echo "--- 24. plan-imports → apply-synthesis (full-page parent-dispatch round-trip) ---"
PLAN_IMP_OUT="$(BRAIN_VAULT_ROOT="${VAULT}" BRAIN_PROJECTS_SOURCE="${FAKE_PROJ_SRC}" \
  node "${ROOT}/server/dist/librarian/cli.js" plan-imports --source "${FAKE_PROJ_SRC}" --status active)"
PLAN_IMP_ID="$(echo "${PLAN_IMP_OUT}" | jq -r '.plan_id')"
# After A: one pending entry per project (not 4). The entry carries
# blocks: [...4 block_ids] and a multi-block schema.
PI_PENDING_COUNT="$(echo "${PLAN_IMP_OUT}" | jq '.pending_imports | length')"
PI_BLOCKS_PER_ENTRY="$(echo "${PLAN_IMP_OUT}" | jq '.pending_imports[0].blocks | length')"
PI_PROJECT_STATUS="$(echo "${PLAN_IMP_OUT}" | jq -r '.pending_imports[0].status')"
PI_SCHEMA_KEYS="$(echo "${PLAN_IMP_OUT}" | jq -r '.pending_imports[0].schema.required | length')"
PI_REC_MODEL="$(echo "${PLAN_IMP_OUT}" | jq -r '.recommended_model')"
PI_GUIDANCE_LEN="$(echo "${PLAN_IMP_OUT}" | jq -r '.dispatch_guidance | length')"
echo "  plan_id=${PLAN_IMP_ID:0:12}... pending_projects=${PI_PENDING_COUNT} blocks=${PI_BLOCKS_PER_ENTRY} status=${PI_PROJECT_STATUS} schema_required=${PI_SCHEMA_KEYS} recommended_model=${PI_REC_MODEL} guidance_len=${PI_GUIDANCE_LEN}"
[[ -n "${PLAN_IMP_ID}" && "${PLAN_IMP_ID}" != "null" \
   && "${PI_PENDING_COUNT}" == "1" \
   && "${PI_BLOCKS_PER_ENTRY}" == "4" \
   && "${PI_PROJECT_STATUS}" == "active" \
   && "${PI_SCHEMA_KEYS}" == "4" \
   && "${PI_REC_MODEL}" == "claude-opus-4-7" && "${PI_GUIDANCE_LEN}" -gt 50 ]] \
  || { echo "  FAIL"; exit 1; }

# Sources should include the README and meta.yaml. Notes, drafts, and
# git-log appear if the fixture has them — the smoke fixture has notes
# (one) and is in a tempdir so no git-log.
PI_SOURCES_HAS_README="$(echo "${PLAN_IMP_OUT}" | jq -r '.pending_imports[0].sources | any(. == "README.md")')"
[[ "${PI_SOURCES_HAS_README}" == "true" ]] || { echo "  FAIL: README missing from sources"; exit 1; }

# Build a hand-crafted full-page response (one Task subagent's output)
# and split it into four per-block result entries — exactly what the
# parent does in production.
WW_BLOCK="$(echo "${PLAN_IMP_OUT}" | jq -r '.pending_imports[0].blocks[] | select(.section_id=="where-we-are") | .block_id')"
BL_BLOCK="$(echo "${PLAN_IMP_OUT}" | jq -r '.pending_imports[0].blocks[] | select(.section_id=="blockers") | .block_id')"
RU_BLOCK="$(echo "${PLAN_IMP_OUT}" | jq -r '.pending_imports[0].blocks[] | select(.section_id=="recent-updates") | .block_id')"
AR_BLOCK="$(echo "${PLAN_IMP_OUT}" | jq -r '.pending_imports[0].blocks[] | select(.section_id=="artifacts") | .block_id')"
APPLY_RESULTS=$(jq -nc \
  --arg ww "${WW_BLOCK}" --arg bl "${BL_BLOCK}" --arg ru "${RU_BLOCK}" --arg ar "${AR_BLOCK}" '
{
  results: [
    { block_id: $ww, output: {
        new_block_body: ("## Where we are\n<!-- brain:block " + $ww + " -->\n\n- Smoke fixture imported via full-page synthesis; pointer page derived from meta.yaml; all four blocks rewritten from README + notes.\n"),
        summary: "Smoke fixture import — verifies single-call full-page synthesis end-to-end.",
        aliases: ["import smoke", "full-page synth"],
        entities: ["plan-imports", "apply-synthesis", "full-page schema"],
        search_terms: ["import round-trip", "single-call synthesis"]
    }},
    { block_id: $bl, output: {
        new_block_body: ("## Open blockers / next actions\n<!-- brain:block " + $bl + " -->\n\n- 2026-04-09 — Open question from README: smoke fixture exercises blocker section.\n"),
        summary: "Open items for the smoke fixture (one synthetic).",
        aliases: ["smoke blockers"],
        entities: [],
        search_terms: ["smoke open question"]
    }},
    { block_id: $ru, output: {
        new_block_body: ("## Recent updates\n<!-- brain:block " + $ru + " -->\n\n- 2026-04-09 — initial framing of smoke fixture.\n"),
        summary: "Timeline for the smoke fixture.",
        aliases: [],
        entities: [],
        search_terms: ["smoke timeline"]
    }},
    { block_id: $ar, output: {
        new_block_body: ("## Artifacts\n<!-- brain:block " + $ar + " -->\n\n- Linear EVALS-999 — fixture tracking ticket.\n"),
        summary: "External pointers for the smoke fixture.",
        aliases: [],
        entities: ["EVALS-999"],
        search_terms: ["smoke artifacts"]
    }}
  ]
}')
RESULTS_FILE="$(mktemp -t brain-import-results.XXXXXX.json)"
jq -nc --arg pid "${PLAN_IMP_ID}" --argjson r "${APPLY_RESULTS}" '{plan_id:$pid} + $r' > "${RESULTS_FILE}"
APPLY_OUT="$(BRAIN_VAULT_ROOT="${VAULT}" \
  node "${ROOT}/server/dist/librarian/cli.js" apply-imports "${PLAN_IMP_ID}" "${RESULTS_FILE}")"
echo "${APPLY_OUT}" | jq -r '"  ok=\(.ok) consolidated=\(.consolidated) all_synthesized=\([.per_block[].method] | unique | join(","))"'
# All four blocks should be method=synthesized (we fed full-page results).
echo "${APPLY_OUT}" | jq -e '.ok == true and ([.per_block[].method] | unique) == ["synthesized"]' >/dev/null \
  || { echo "  FAIL"; exit 1; }

# Page should now have import_source_sha256 stamped.
HAS_SHA="$(/usr/bin/python3 -c "
import sys
import re
body = open('${VAULT}/projects/imp-fixture.md').read()
print('yes' if re.search(r'^import_source_sha256:', body, re.M) else 'no')
")"
[[ "${HAS_SHA}" == "yes" ]] && echo "  import_source_sha256 stamped OK" \
  || { echo "  FAIL: sha not stamped"; exit 1; }

# Re-running plan-imports with same content should skip (sha match).
PLAN_RERUN="$(BRAIN_VAULT_ROOT="${VAULT}" BRAIN_PROJECTS_SOURCE="${FAKE_PROJ_SRC}" \
  node "${ROOT}/server/dist/librarian/cli.js" plan-imports --source "${FAKE_PROJ_SRC}" --status active)"
RERUN_PENDING="$(echo "${PLAN_RERUN}" | jq '.pending_imports | length')"
echo "  rerun pending=${RERUN_PENDING}"
[[ "${RERUN_PENDING}" == "0" ]] || { echo "  FAIL: re-run should skip via sha"; exit 1; }

echo "--- 24b. status-aware source filtering: done < active ---"
# Build two fixtures with the same content but different statuses,
# count sources from plan-imports for each.
TIER_SRC="$(mktemp -d -t brain-tier-smoke.XXXXXX)/projects"
mkdir -p "${TIER_SRC}/tier-active-2026-04-01/notes" "${TIER_SRC}/tier-done-2026-04-01/notes"
cat > "${TIER_SRC}/tier-active-2026-04-01/meta.yaml" <<EOF
project: tier-active-2026-04-01
created: 2026-04-01
status: active
owner: bjorn
EOF
cat > "${TIER_SRC}/tier-done-2026-04-01/meta.yaml" <<EOF
project: tier-done-2026-04-01
created: 2026-04-01
status: complete
owner: bjorn
EOF
echo "# active" > "${TIER_SRC}/tier-active-2026-04-01/README.md"
echo "# done"   > "${TIER_SRC}/tier-done-2026-04-01/README.md"
# Drop 8 notes in each — active should keep all 8, done keeps last 3.
for i in 1 2 3 4 5 6 7 8; do
  d=$(/bin/date -u -j -v-${i}d +%Y-%m-%d 2>/dev/null || /bin/date -u -d "${i} days ago" +%Y-%m-%d)
  echo "- note ${i}" > "${TIER_SRC}/tier-active-2026-04-01/notes/${d}-note${i}.md"
  echo "- note ${i}" > "${TIER_SRC}/tier-done-2026-04-01/notes/${d}-note${i}.md"
done
TIER_OUT="$(BRAIN_VAULT_ROOT="${VAULT}" BRAIN_PROJECTS_SOURCE="${TIER_SRC}" \
  node "${ROOT}/server/dist/librarian/cli.js" plan-imports --source "${TIER_SRC}" --status active,done --force)"
ACTIVE_SRC_N="$(echo "${TIER_OUT}" | jq '.pending_imports[] | select(.project_slug == "tier-active") | .sources | length')"
DONE_SRC_N="$(echo "${TIER_OUT}" | jq '.pending_imports[] | select(.project_slug == "tier-done") | .sources | length')"
echo "  active_sources=${ACTIVE_SRC_N} done_sources=${DONE_SRC_N}"
[[ -n "${ACTIVE_SRC_N}" && -n "${DONE_SRC_N}" && "${ACTIVE_SRC_N}" -gt "${DONE_SRC_N}" ]] \
  && echo "  status tiering OK (done < active)" \
  || { echo "  FAIL"; exit 1; }
rm -rf "$(/usr/bin/dirname "${TIER_SRC}")"

# Cleanup: remove the imp-fixture + tier fixture pages.
rm -rf "$(/usr/bin/dirname "${FAKE_PROJ_SRC}")"
rm -f "${RESULTS_FILE}"
rm -f "${VAULT}/projects/imp-fixture.md"
rm -f "${VAULT}/.brain/provenance/projects/imp-fixture.json"
rm -f "${VAULT}/projects/tier-active.md" "${VAULT}/projects/tier-done.md"
rm -f "${VAULT}/.brain/provenance/projects/tier-active.json" "${VAULT}/.brain/provenance/projects/tier-done.json"

CAPTURE_POST_COUNT="$(/bin/ls "${VAULT}/captures" 2>/dev/null | wc -l | tr -d ' ')"
echo "---"
echo "captures: ${CAPTURE_PRE_COUNT} -> ${CAPTURE_POST_COUNT}"
echo "smoke test passed."
