#!/usr/bin/env bash
# Tier-1 smoke test for the brain MCP server. Local-only; no real
# `claude` invocations (so no LLM costs); does not modify
# ~/.claude/settings.json.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SERVER="${ROOT}/server/dist/index.js"
NODE="${ROOT}/scripts/brain-node"

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

# Librarian-flow MCP tools are gated. The smoke test exercises them
# via MCP, so opt them in for the duration of this run.
export BRAIN_EXPOSE_LIBRARIAN_TOOLS=1

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
    | BRAIN_VAULT_ROOT="${VAULT}" "${NODE}" "${SERVER}" 2>/dev/null \
    | tail -n 1
}

echo "--- 1. tools/list (default + librarian flag) ---"
# With BRAIN_EXPOSE_LIBRARIAN_TOOLS=1 (set above): 6 always-on tools
# (read, search, search-finalize, capture, index, status) + 3 gated
# librarian-* tools = 9.
n=$(mcp "tools/list" '{}' | jq '.result.tools | length')
echo "  tool_count=${n}  (expected 9 with flag)"
[[ "${n}" == "9" ]] || { echo "FAIL: tool_count=${n}"; exit 1; }
# And the always-on default surface is 6.
n_default=$(BRAIN_EXPOSE_LIBRARIAN_TOOLS= /usr/bin/env -u BRAIN_EXPOSE_LIBRARIAN_TOOLS \
  bash -c '
    printf "%s\n%s\n%s\n" \
      "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2024-11-05\",\"capabilities\":{},\"clientInfo\":{\"name\":\"smoke\",\"version\":\"0\"}}}" \
      "{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}" \
      "{\"jsonrpc\":\"2.0\",\"id\":99,\"method\":\"tools/list\",\"params\":{}}" \
    | BRAIN_VAULT_ROOT="'"${VAULT}"'" "'"${NODE}"'" "'"${SERVER}"'" 2>/dev/null \
    | tail -n 1
  ' | jq '.result.tools | length')
echo "  tool_count_default=${n_default}  (expected 6 without flag)"
[[ "${n_default}" == "6" ]] || { echo "FAIL: default tool_count=${n_default}"; exit 1; }

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

echo "--- 6b. brain-read mode=provenance (folded from brain-read-provenance) ---"
# No sidecar yet for profile/me.md → expect found=false, NO_SIDECAR.
mcp "tools/call" '{"path":"profile/me.md","mode":"provenance"}' "brain-read" \
  | jq -r '.result.content[0].text | fromjson | "  exists=\(.exists) mode=\(.mode) error=\(.error.code // "none")"'

mkdir -p /tmp/brain-smoke && echo "TOKEN=hunter2" > /tmp/brain-smoke/.env
echo "--- 7. brain-librarian ingest .env rejected (CLI) ---"
"${NODE}" "${ROOT}/server/dist/librarian/cli.js" ingest --source /tmp/brain-smoke/.env \
  | jq -r '"  error_code=\(.error.code)"'
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
          "${NODE}" "${ROOT}/server/dist/librarian/cli.js" consolidate --synthesize)"
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

echo "--- 21c. brain-capture worker emits cost_usd / token fields when fake reports them ---"
# Run the worker once with the fake stubbing cost + tokens. Then assert
# the new fields appear in the worker log line and that brain-cost
# picks them up.
: > "${VAULT}/.brain/state/capture-queue.jsonl"
JSONL_COST="${FAKE_PROJ}/encoded-cwd/smoke-session-cost.jsonl"
echo '{"role":"user","content":"cost-aware run"}' > "${JSONL_COST}"
BRAIN_VAULT_ROOT="${VAULT}" BRAIN_CLAUDE_PROJECTS="${FAKE_PROJ}" \
  CLAUDE_BIN="${ROOT}/scripts/fake-claude-delta-classifier.sh" \
  BRAIN_FAKE_SLUG=smoke-cost \
  BRAIN_FAKE_DELTA_OUTCOME=CAPTURE_CREATED \
  BRAIN_FAKE_COST_USD=0.0234 \
  BRAIN_FAKE_IN_TOKENS=1500 \
  BRAIN_FAKE_OUT_TOKENS=240 \
  "${ROOT}/capture/brain-capture.sh"
LAST_LINE="$(/usr/bin/tail -n 1 "${VAULT}/.brain/log/capture-$(date +%Y-%m-%d).log")"
echo "  log_tail: ${LAST_LINE}"
[[ "${LAST_LINE}" == *"cost_usd=0.023400"* && "${LAST_LINE}" == *"in_tokens=1500"* && "${LAST_LINE}" == *"out_tokens=240"* ]] \
  && echo "  cost fields present in log OK" \
  || { echo "  FAIL: missing cost fields"; exit 1; }

# Aggregate via CLI for a date-bracketed query, and via brain-status
# for the always-on summary view. Both should pick up the run.
TODAY="$(date +%Y-%m-%d)"
COST_OUT="$("${NODE}" "${ROOT}/server/dist/librarian/cli.js" cost --since "${TODAY}" --until "${TODAY}")"
COST_TOTAL="$(echo "${COST_OUT}" | jq -r '.total_cost_usd')"
COST_RUNS="$(echo "${COST_OUT}" | jq -r '.capture.runs')"
STATUS_TODAY="$(mcp "tools/call" '{}' "brain-status" \
  | jq -r '.result.content[0].text | fromjson | .usage.today_usd')"
echo "  cost CLI: total_usd=${COST_TOTAL} capture_runs=${COST_RUNS}; status.usage.today_usd=${STATUS_TODAY}"
# Sum may include other test runs in the same vault; just assert >= 0.0234
# and that capture.runs is at least 1.
[[ "${COST_RUNS}" -ge "1" ]] \
  && /usr/bin/python3 -c "import sys; sys.exit(0 if float('${COST_TOTAL}') >= 0.0234 else 1)" \
  && /usr/bin/python3 -c "import sys; sys.exit(0 if float('${STATUS_TODAY}') >= 0.0234 else 1)" \
  && echo "  cost CLI + brain-status.usage both pick up the worker run OK" \
  || { echo "  FAIL: cli total=${COST_TOTAL} runs=${COST_RUNS} status_today=${STATUS_TODAY}"; exit 1; }
# Clean up the cost-test session marker.
/usr/bin/python3 -c "
import json
p = '${VAULT}/.brain/state/capture-markers.json'
d = json.load(open(p))
d.pop('smoke-session-cost', None)
json.dump(d, open(p, 'w'))
"

# Cleanup the bigdelta marker so subsequent runs aren't confused.
/usr/bin/python3 -c "
import json
p = '${VAULT}/.brain/state/capture-markers.json'
d = json.load(open(p))
d.pop('smoke-session-bigdelta', None)
json.dump(d, open(p, 'w'))
"

# Cleanup capture files written by 19 + 21 + 21b + 21c
/usr/bin/find "${VAULT}/captures" -name 'session-smoke-session-noop-*.md' -delete 2>/dev/null || true
/usr/bin/find "${VAULT}/captures" -name 'session-smoke-session-queued-*.md' -delete 2>/dev/null || true
/usr/bin/find "${VAULT}/captures" -name 'session-smoke-session-bigdelta-*.md' -delete 2>/dev/null || true
/usr/bin/find "${VAULT}/captures" -name 'session-smoke-session-cost-*.md' -delete 2>/dev/null || true

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
  "${NODE}" "${ROOT}/server/dist/librarian/cli.js" import-pointers --source "${FAKE_PROJ_SRC}")"
echo "${IMP_OUT}" | jq -r '"  scanned=\(.scanned) created=\(.created | length) skipped=\(.skipped | length) collisions=\(.collisions | length) errors=\(.errors | length)"'
[[ -f "${VAULT}/projects/imp-fixture.md" ]] || { echo "  FAIL: imp-fixture.md not created"; exit 1; }
echo "${IMP_OUT}" | jq -e '.created[0].slug == "imp-fixture" and (.scanned == 1)' >/dev/null \
  || { echo "  FAIL"; exit 1; }
echo "  pointer page OK"

echo "--- 23. import-pointers re-run is a no-op (already_present) ---"
IMP_OUT2="$(BRAIN_VAULT_ROOT="${VAULT}" BRAIN_PROJECTS_SOURCE="${FAKE_PROJ_SRC}" \
  "${NODE}" "${ROOT}/server/dist/librarian/cli.js" import-pointers --source "${FAKE_PROJ_SRC}")"
echo "${IMP_OUT2}" | jq -r '"  created=\(.created | length) skipped=\(.skipped | length)"'
echo "${IMP_OUT2}" | jq -e '(.created | length) == 0 and (.skipped | length) == 1' >/dev/null \
  || { echo "  FAIL"; exit 1; }
echo "  idempotent OK"

echo "--- 24. plan-imports → apply-synthesis (full-page parent-dispatch round-trip) ---"
PLAN_IMP_OUT="$(BRAIN_VAULT_ROOT="${VAULT}" BRAIN_PROJECTS_SOURCE="${FAKE_PROJ_SRC}" \
  "${NODE}" "${ROOT}/server/dist/librarian/cli.js" plan-imports --source "${FAKE_PROJ_SRC}" --status active)"
PLAN_IMP_ID="$(echo "${PLAN_IMP_OUT}" | jq -r '.plan_id')"
# After PLAN_v3 delta #15 (Where-we-are moved to on-demand brokered
# search), the full-page import schema produces three blocks per
# project, not four.
PI_PENDING_COUNT="$(echo "${PLAN_IMP_OUT}" | jq '.pending_imports | length')"
PI_BLOCKS_PER_ENTRY="$(echo "${PLAN_IMP_OUT}" | jq '.pending_imports[0].blocks | length')"
PI_PROJECT_STATUS="$(echo "${PLAN_IMP_OUT}" | jq -r '.pending_imports[0].status')"
PI_SCHEMA_KEYS="$(echo "${PLAN_IMP_OUT}" | jq -r '.pending_imports[0].schema.required | length')"
PI_REC_MODEL="$(echo "${PLAN_IMP_OUT}" | jq -r '.recommended_model')"
PI_GUIDANCE_LEN="$(echo "${PLAN_IMP_OUT}" | jq -r '.dispatch_guidance | length')"
echo "  plan_id=${PLAN_IMP_ID:0:12}... pending_projects=${PI_PENDING_COUNT} blocks=${PI_BLOCKS_PER_ENTRY} status=${PI_PROJECT_STATUS} schema_required=${PI_SCHEMA_KEYS} recommended_model=${PI_REC_MODEL} guidance_len=${PI_GUIDANCE_LEN}"
[[ -n "${PLAN_IMP_ID}" && "${PLAN_IMP_ID}" != "null" \
   && "${PI_PENDING_COUNT}" == "1" \
   && "${PI_BLOCKS_PER_ENTRY}" == "3" \
   && "${PI_PROJECT_STATUS}" == "active" \
   && "${PI_SCHEMA_KEYS}" == "3" \
   && "${PI_REC_MODEL}" == "claude-opus-4-7" && "${PI_GUIDANCE_LEN}" -gt 50 ]] \
  || { echo "  FAIL"; exit 1; }

# Sources should include the README and meta.yaml. Notes, drafts, and
# git-log appear if the fixture has them — the smoke fixture has notes
# (one) and is in a tempdir so no git-log.
PI_SOURCES_HAS_README="$(echo "${PLAN_IMP_OUT}" | jq -r '.pending_imports[0].sources | any(. == "README.md")')"
[[ "${PI_SOURCES_HAS_README}" == "true" ]] || { echo "  FAIL: README missing from sources"; exit 1; }

# Build a hand-crafted full-page response (one Task subagent's output)
# and split it into per-block result entries — exactly what the parent
# does in production.
BL_BLOCK="$(echo "${PLAN_IMP_OUT}" | jq -r '.pending_imports[0].blocks[] | select(.section_id=="blockers") | .block_id')"
RU_BLOCK="$(echo "${PLAN_IMP_OUT}" | jq -r '.pending_imports[0].blocks[] | select(.section_id=="recent-updates") | .block_id')"
AR_BLOCK="$(echo "${PLAN_IMP_OUT}" | jq -r '.pending_imports[0].blocks[] | select(.section_id=="artifacts") | .block_id')"
APPLY_RESULTS=$(jq -nc \
  --arg bl "${BL_BLOCK}" --arg ru "${RU_BLOCK}" --arg ar "${AR_BLOCK}" '
{
  results: [
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
  "${NODE}" "${ROOT}/server/dist/librarian/cli.js" apply-imports "${PLAN_IMP_ID}" "${RESULTS_FILE}")"
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
  "${NODE}" "${ROOT}/server/dist/librarian/cli.js" plan-imports --source "${FAKE_PROJ_SRC}" --status active)"
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
  "${NODE}" "${ROOT}/server/dist/librarian/cli.js" plan-imports --source "${TIER_SRC}" --status active,done --force)"
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

echo "--- 25. de-dup: identical bullets collapse to one on deterministic append ---"
# Two captures with identical body for the same slug. Deterministic
# consolidate (no --synthesize) appends bullets one at a time; the
# second append sees the first already present and skips.
DEDUP_TS=$(date +%s)
cat > "${VAULT}/captures/session-dedup1-${DEDUP_TS}.md" <<EOF
---
session_id: dedup1
created_at: 2026-05-03T10:00:00Z
trigger: manual
project_slug: dedup-smoke
capture_kind: finding
---
## Findings
- Identical-bullet dedup test; should appear exactly once on the page.
EOF
cat > "${VAULT}/captures/session-dedup2-${DEDUP_TS}.md" <<EOF
---
session_id: dedup2
created_at: 2026-05-03T11:00:00Z
trigger: manual
project_slug: dedup-smoke
capture_kind: finding
---
## Findings
- Identical-bullet dedup test; should appear exactly once on the page.
EOF
BRAIN_VAULT_ROOT="${VAULT}" "${NODE}" "${ROOT}/server/dist/librarian/cli.js" consolidate >/dev/null
DEDUP_BULLETS=$(grep -c "Identical-bullet dedup test" "${VAULT}/projects/dedup-smoke.md" 2>/dev/null || echo 0)
echo "  bullets_on_page=${DEDUP_BULLETS}"
[[ "${DEDUP_BULLETS}" == "1" ]] || { echo "  FAIL: expected 1 bullet, got ${DEDUP_BULLETS}"; exit 1; }
echo "  dedup OK"

echo "--- 26. importer input cap: oversized project triggers _truncation-note ---"
# Write a config override capping import input at 10 KB, then build
# a fixture whose notes total well over that. plan-imports should
# emit a _truncation-note source and the prompt should mention it.
mkdir -p "${VAULT}/.brain"
cat > "${VAULT}/.brain/config.yaml" <<EOF
librarian:
  import_max_input_bytes: 10240
EOF
BIG_PROJ_SRC="$(mktemp -d -t brain-bigimport-smoke.XXXXXX)/projects"
mkdir -p "${BIG_PROJ_SRC}/big-fixture-2026-05-03/notes"
cat > "${BIG_PROJ_SRC}/big-fixture-2026-05-03/meta.yaml" <<EOF
project: big-fixture-2026-05-03
created: 2026-05-03
status: active
owner: bjorn
tags: [smoke]
EOF
echo "# Big fixture — current state in one line." > "${BIG_PROJ_SRC}/big-fixture-2026-05-03/README.md"
# 60 notes × ~500 bytes ≈ 30 KB total, well past the 10 KB cap.
BRAIN_NOTES_DIR="${BIG_PROJ_SRC}/big-fixture-2026-05-03/notes" /usr/bin/python3 - <<'PY'
import os
notes_dir = os.environ["BRAIN_NOTES_DIR"]
for i in range(1, 61):
    fname = f"note-{i:02d}.md"
    body = f"# note {i}\n" + ("lorem ipsum dolor sit amet " * 18)
    open(os.path.join(notes_dir, fname), "w").write(body)
PY
# Pre-clean.
rm -f "${VAULT}/projects/big-fixture.md" 2>/dev/null
BRAIN_VAULT_ROOT="${VAULT}" BRAIN_PROJECTS_SOURCE="${BIG_PROJ_SRC}" \
  "${NODE}" "${ROOT}/server/dist/librarian/cli.js" import-pointers --source "${BIG_PROJ_SRC}" >/dev/null
PLAN_BIG_OUT="$(BRAIN_VAULT_ROOT="${VAULT}" BRAIN_PROJECTS_SOURCE="${BIG_PROJ_SRC}" \
  "${NODE}" "${ROOT}/server/dist/librarian/cli.js" plan-imports --source "${BIG_PROJ_SRC}" --status active)"
HAS_TRUNCATION=$(echo "${PLAN_BIG_OUT}" | jq -r '.pending_imports[0].prompt' | grep -c "_truncation-note" || echo 0)
HAS_TRUNCATION_BODY=$(echo "${PLAN_BIG_OUT}" | jq -r '.pending_imports[0].prompt' | grep -c "INPUT TRUNCATED" || echo 0)
echo "  truncation_note_in_prompt=${HAS_TRUNCATION} truncation_body_in_prompt=${HAS_TRUNCATION_BODY}"
[[ "${HAS_TRUNCATION}" -ge 1 && "${HAS_TRUNCATION_BODY}" -ge 1 ]] \
  || { echo "  FAIL: truncation note not emitted"; exit 1; }
echo "  importer cap OK"
# Clean up the cap override so subsequent runs aren't affected.
rm -f "${VAULT}/.brain/config.yaml"
rm -rf "$(/usr/bin/dirname "${BIG_PROJ_SRC}")"
rm -f "${VAULT}/projects/big-fixture.md" "${VAULT}/.brain/provenance/projects/big-fixture.json"

echo "--- 27. brain-librarian lint sweeps stale traces and trims old session lines ---"
# Stale search-run trace + stale synthesis-plan; should both be swept.
STALE_RUN="${VAULT}/.brain/search/runs/01STALE0000000000000000000.json"
mkdir -p "$(/usr/bin/dirname "${STALE_RUN}")"
echo '{"search_id":"01STALE","investigator":{"status":"pending_parent_dispatch"}}' > "${STALE_RUN}"
/usr/bin/touch -t 202401010000 "${STALE_RUN}"
STALE_PLAN="${VAULT}/.brain/state/synthesis-plans/PLAN_STALE_0001.json"
mkdir -p "$(/usr/bin/dirname "${STALE_PLAN}")"
echo '{"plan_id":"PLAN_STALE_0001"}' > "${STALE_PLAN}"
/usr/bin/touch -t 202401010000 "${STALE_PLAN}"
# Active-sessions: chatty session (old + recent → keep all), old-only session (drop all).
SESSIONS_LOG="${VAULT}/.brain/state/active-sessions.jsonl"
cat > "${SESSIONS_LOG}" <<EOF
{"session_id":"chatty","last_seen_at":"2024-01-01T00:00:00Z"}
{"session_id":"chatty","last_seen_at":"2026-05-01T00:00:00Z"}
{"session_id":"old-only","last_seen_at":"2024-01-01T00:00:00Z"}
EOF
LINT_OUT="$(BRAIN_VAULT_ROOT="${VAULT}" \
  "${NODE}" "${ROOT}/server/dist/librarian/cli.js" lint)"
echo "  ${LINT_OUT}"
echo "${LINT_OUT}" | jq -e '
  .swept_search_runs == 1
  and .swept_synthesis_plans == 1
  and .trimmed_session_lines == 1
  and .preserved_session_lines == 2
  and .errors == 0
' >/dev/null || { echo "  FAIL"; exit 1; }
[[ ! -f "${STALE_RUN}" ]] || { echo "  FAIL: stale search-run not removed"; exit 1; }
[[ ! -f "${STALE_PLAN}" ]] || { echo "  FAIL: stale synthesis-plan not removed"; exit 1; }
grep -q "chatty" "${SESSIONS_LOG}" || { echo "  FAIL: chatty session was wrongly trimmed"; exit 1; }
! grep -q "old-only" "${SESSIONS_LOG}" || { echo "  FAIL: old-only session was wrongly preserved"; exit 1; }
echo "  lint sweep OK"

echo "--- 28. brain-librarian lint sweeps truncated fallback bullets ---"
# Fixture page with truncated-fallback bullets that MUST be removed,
# clean bullets that MUST remain, plus adversarial "false-positive
# guard" bullets that match shapes the heuristic could mis-flag if it
# weren't anchored to the fallback-bullet fingerprint.
TRUNC_PAGE="${VAULT}/projects/lint-trunc-fixture.md"
mkdir -p "${VAULT}/projects"
cat > "${TRUNC_PAGE}" <<'EOF'
---
slug: lint-trunc-fixture
last_touched: '2026-05-12T00:00:00.000Z'
status: active
---
# Lint trunc fixture

## Where we are
<!-- brain:block project.lint-trunc-fixture.where-we-are.v1 -->

_(no entries yet)_

## Open blockers / next actions
<!-- brain:block project.lint-trunc-fixture.blockers.v1 -->

_(no entries yet)_

## Recent updates
<!-- brain:block project.lint-trunc-fixture.recent-updates.v1 -->

- 2026-05-12 — Clean bullet with a `**bold**` inline run and a terminal period.
- 2026-05-12 — **v1 (`pivot-prompt-only`) has been conclusively shown to NOT work in
- 2026-05-12 — **Tier-1 offline eval (stk-050) is no longer the operative read.** The
- 2026-05-12 — Another clean bullet, closed and complete.
- 2026-05-13 — Hand-written bullet ending in "the" without the fingerprint prefix the
- 2026-05-14 — Math notation: cost scales as N**2 for large N.
- 2026-05-15 — Bullet with backslash-bold literal \\**critical**: don't use backslash literals on Windows.
- 2026-05-16 — Mid-line code `state is` should not flag the bullet to
- 2026-05-17 — **Closed-bold legitimate bullet with no trailing dangle.**

## Artifacts
<!-- brain:block project.lint-trunc-fixture.artifacts.v1 -->

_(no entries yet)_
EOF
LINT_OUT2="$(BRAIN_VAULT_ROOT="${VAULT}" \
  "${NODE}" "${ROOT}/server/dist/librarian/cli.js" lint)"
echo "  ${LINT_OUT2}"
echo "${LINT_OUT2}" | jq -e '
  .pages_touched == 1
  and .truncated_bullets_removed == 2
  and .errors == 0
' >/dev/null || { echo "  FAIL: counters off"; exit 1; }
# Both removable bullets must be gone.
! grep -q "shown to NOT work in$" "${TRUNC_PAGE}" || { echo "  FAIL: unclosed-bold bullet still on page"; exit 1; }
! grep -q "operative read.\*\* The$" "${TRUNC_PAGE}" || { echo "  FAIL: dangling-word bullet still on page"; exit 1; }
# Every clean / adversarial bullet MUST remain — false positives here are
# the failure mode the design is most paranoid about.
for needle in \
  "Clean bullet with a" \
  "Another clean bullet" \
  "Hand-written bullet ending in" \
  "Math notation: cost scales" \
  "backslash literals on Windows" \
  "Mid-line code" \
  "Closed-bold legitimate bullet"; do
  grep -qF "${needle}" "${TRUNC_PAGE}" || { echo "  FAIL: false-positive deletion of legitimate bullet: '${needle}'"; exit 1; }
done
# Needs-review audit file must exist and contain both removed bullets.
AUDIT=$(/bin/ls "${VAULT}/.brain/needs-review/"truncated-bullets-*-lint-trunc-fixture.md 2>/dev/null | head -1)
[[ -n "${AUDIT}" ]] || { echo "  FAIL: audit file not written"; exit 1; }
grep -q "shown to NOT work in" "${AUDIT}" || { echo "  FAIL: audit missing unclosed-bold bullet"; exit 1; }
grep -q "operative read" "${AUDIT}" || { echo "  FAIL: audit missing dangling-word bullet"; exit 1; }
# Structural invariants: rewrite must preserve frontmatter + every
# block marker. A bug in slice offsets or stringifyDoc that mangles
# structure (drops frontmatter, removes a marker) would still pass the
# substring assertions above — these guards catch that class.
grep -q "^slug: lint-trunc-fixture$" "${TRUNC_PAGE}" || { echo "  FAIL: frontmatter lost"; exit 1; }
MARKER_COUNT=$(grep -c "<!-- brain:block project.lint-trunc-fixture" "${TRUNC_PAGE}")
[[ "${MARKER_COUNT}" == "4" ]] || { echo "  FAIL: block markers lost (found ${MARKER_COUNT}/4)"; exit 1; }
# Rewrite must have updated last_touched. Tolerant of YAML quote style.
LAST_TOUCHED_LINE=$(grep "^last_touched:" "${TRUNC_PAGE}")
echo "${LAST_TOUCHED_LINE}" | grep -q "2026-05-12T00:00:00" \
  && { echo "  FAIL: last_touched still at fixture value: ${LAST_TOUCHED_LINE}"; exit 1; }
# Re-run is a no-op (idempotent).
LINT_OUT3="$(BRAIN_VAULT_ROOT="${VAULT}" \
  "${NODE}" "${ROOT}/server/dist/librarian/cli.js" lint)"
echo "${LINT_OUT3}" | jq -e '.pages_touched == 0 and .truncated_bullets_removed == 0' >/dev/null \
  || { echo "  FAIL: re-run wasn't idempotent"; exit 1; }
# Orphan-tmp cleanup: drop a stale tmp into projects/, plus a "tricky"
# page whose slug contains `.md.tmp.` literally, run lint, verify the
# orphan is gone AND both legitimate pages survive.
ORPHAN="${VAULT}/projects/lint-trunc-fixture.md.tmp.99999.1234567890.deadbeef"
echo "stale tmp" > "${ORPHAN}"
TRICKY_PAGE="${VAULT}/projects/notes.md.tmp.archive.md"
echo "---
slug: notes.md.tmp.archive
---
# Notes archive
" > "${TRICKY_PAGE}"
BRAIN_VAULT_ROOT="${VAULT}" "${NODE}" "${ROOT}/server/dist/librarian/cli.js" lint >/dev/null
[[ ! -f "${ORPHAN}" ]] || { echo "  FAIL: orphan tmp not swept"; exit 1; }
[[ -f "${TRUNC_PAGE}" ]] || { echo "  FAIL: fixture page wrongly unlinked"; exit 1; }
[[ -f "${TRICKY_PAGE}" ]] || { echo "  FAIL: page with .md.tmp. in slug wrongly unlinked"; exit 1; }
echo "  truncated-bullet cleanup OK"

echo "--- 29. brain-search intent=where_are_we (on-demand broker, cache, invalidation) ---"
# Build a fresh project page + one processed capture for that project.
WWA_SLUG="wwa-fixture"
WWA_PAGE="${VAULT}/projects/${WWA_SLUG}.md"
mkdir -p "${VAULT}/projects" "${VAULT}/.brain/processed"
cat > "${WWA_PAGE}" <<EOF
---
slug: ${WWA_SLUG}
last_touched: '2026-05-12T00:00:00.000Z'
status: active
---
# WWA fixture

## Open blockers / next actions
<!-- brain:block project.${WWA_SLUG}.blockers.v1 -->

- 2026-05-11 — blocked on classifier reliability; needs n=50 calibration pass.

## Recent updates
<!-- brain:block project.${WWA_SLUG}.recent-updates.v1 -->

- 2026-05-11 — landed first classifier prototype; offline eval at 0.62 macro-F1.

## Artifacts
<!-- brain:block project.${WWA_SLUG}.artifacts.v1 -->

_(no entries yet)_
EOF
WWA_PROC="${VAULT}/.brain/processed/session-wwafix-1.md"
cat > "${WWA_PROC}" <<EOF
---
session_id: wwafix
created_at: '2026-05-12T07:00:00.000Z'
trigger: manual
project_slug: ${WWA_SLUG}
capture_kind: finding
---
## Findings
- WWA fixture capture content; should appear as a candidate.
EOF

# 29a. fast mode — deterministic candidates, no LLM, kind=dossier.
WWA_FAST="$(mcp "tools/call" \
  "$(jq -nc --arg s "${WWA_SLUG}" '{query:"where are we on \($s)", intent:"where_are_we", project_slug:$s, depth:"fast"}')" \
  "brain-search")"
WWA_FAST_KIND="$(echo "${WWA_FAST}" | jq -r '.result.content[0].text | fromjson | .kind')"
WWA_FAST_CANDS="$(echo "${WWA_FAST}" | jq -r '.result.content[0].text | fromjson | .dossier.diagnostics.candidates_considered')"
echo "  fast kind=${WWA_FAST_KIND} candidates=${WWA_FAST_CANDS}"
[[ "${WWA_FAST_KIND}" == "dossier" && "${WWA_FAST_CANDS}" == "2" ]] || { echo "  FAIL: fast mode shape"; exit 1; }

# 29b. standard mode — kind=pending_dispatch, prompt mentions page + capture.
WWA_STD="$(mcp "tools/call" \
  "$(jq -nc --arg s "${WWA_SLUG}" '{query:"where are we on \($s)", intent:"where_are_we", project_slug:$s, depth:"standard"}')" \
  "brain-search")"
WWA_STD_KIND="$(echo "${WWA_STD}" | jq -r '.result.content[0].text | fromjson | .kind')"
WWA_STD_ID="$(echo "${WWA_STD}" | jq -r '.result.content[0].text | fromjson | .search_id')"
WWA_STD_PROMPT_HAS_PAGE="$(echo "${WWA_STD}" | jq -r '.result.content[0].text | fromjson | .prompt | contains("projects/'"${WWA_SLUG}"'.md")')"
WWA_STD_PROMPT_HAS_CAP="$(echo "${WWA_STD}" | jq -r '.result.content[0].text | fromjson | .prompt | contains("WWA fixture capture content")')"
echo "  std kind=${WWA_STD_KIND} prompt-has-page=${WWA_STD_PROMPT_HAS_PAGE} prompt-has-capture=${WWA_STD_PROMPT_HAS_CAP}"
[[ "${WWA_STD_KIND}" == "pending_dispatch" \
   && "${WWA_STD_PROMPT_HAS_PAGE}" == "true" \
   && "${WWA_STD_PROMPT_HAS_CAP}" == "true" ]] || { echo "  FAIL: standard mode shape"; exit 1; }

# 29c. finalize with a hand-crafted dossier → cache file written.
WWA_DOSS=$(jq -nc '{
  query_interpretation: "Holistic state of WWA fixture project.",
  answer: "Project active. Classifier prototype landed at 0.62 macro-F1; blocked on n=50 calibration pass.",
  confidence: "high",
  sources: [],
  suggested_reads: [],
  open_questions: []
}')
WWA_FIN_INPUT=$(jq -nc --arg sid "${WWA_STD_ID}" --argjson d "${WWA_DOSS}" '{search_id:$sid, dossier:$d}')
WWA_FIN="$(mcp "tools/call" "${WWA_FIN_INPUT}" "brain-search-finalize")"
echo "${WWA_FIN}" | jq -e '.result.content[0].text | fromjson | .ok == true' >/dev/null \
  || { echo "  FAIL: finalize"; exit 1; }
WWA_CACHE="${VAULT}/.brain/search/cache/where-we-are/${WWA_SLUG}.json"
[[ -f "${WWA_CACHE}" ]] || { echo "  FAIL: cache not written at ${WWA_CACHE}"; exit 1; }
echo "  cache written: $(basename "${WWA_CACHE}")"

# 29d. re-query with the same page mtime → cache HIT (kind=dossier,
#       investigator_status=cache_hit), no new pending_dispatch.
WWA_HIT="$(mcp "tools/call" \
  "$(jq -nc --arg s "${WWA_SLUG}" '{query:"where are we on \($s)", intent:"where_are_we", project_slug:$s, depth:"standard"}')" \
  "brain-search")"
WWA_HIT_KIND="$(echo "${WWA_HIT}" | jq -r '.result.content[0].text | fromjson | .kind')"
WWA_HIT_STATUS="$(echo "${WWA_HIT}" | jq -r '.result.content[0].text | fromjson | .dossier.diagnostics.investigator_status')"
WWA_HIT_ANSWER="$(echo "${WWA_HIT}" | jq -r '.result.content[0].text | fromjson | .dossier.answer')"
echo "  hit kind=${WWA_HIT_KIND} status=${WWA_HIT_STATUS}"
[[ "${WWA_HIT_KIND}" == "dossier" && "${WWA_HIT_STATUS}" == "cache_hit" ]] || { echo "  FAIL: cache hit shape"; exit 1; }
echo "${WWA_HIT_ANSWER}" | grep -q "Classifier prototype landed" || { echo "  FAIL: cached answer not returned"; exit 1; }

# 29e. inode-only mtime bump (no content change) → cache STILL HITS.
# This is the deliberate behaviour: git checkout / rsync / backup tools
# bump mtime without changing content; spurious re-dispatch would be
# wasteful and was a reviewer-flagged regression risk.
sleep 1
/usr/bin/touch "${WWA_PAGE}"
WWA_TOUCH="$(mcp "tools/call" \
  "$(jq -nc --arg s "${WWA_SLUG}" '{query:"where are we on \($s)", intent:"where_are_we", project_slug:$s, depth:"standard"}')" \
  "brain-search")"
WWA_TOUCH_KIND="$(echo "${WWA_TOUCH}" | jq -r '.result.content[0].text | fromjson | .kind')"
WWA_TOUCH_STATUS="$(echo "${WWA_TOUCH}" | jq -r '.result.content[0].text | fromjson | .dossier.diagnostics.investigator_status')"
echo "  inode-touch kind=${WWA_TOUCH_KIND} status=${WWA_TOUCH_STATUS}"
[[ "${WWA_TOUCH_KIND}" == "dossier" && "${WWA_TOUCH_STATUS}" == "cache_hit" ]] || { echo "  FAIL: inode-only touch should NOT invalidate the cache"; exit 1; }

# 29f. real content change → cache MISSES, re-dispatches.
echo "" >> "${WWA_PAGE}"  # add a newline → content sha changes
echo "- 2026-05-12 — fresh bullet added after first dispatch." >> "${WWA_PAGE}"
WWA_MISS="$(mcp "tools/call" \
  "$(jq -nc --arg s "${WWA_SLUG}" '{query:"where are we on \($s)", intent:"where_are_we", project_slug:$s, depth:"standard"}')" \
  "brain-search")"
WWA_MISS_KIND="$(echo "${WWA_MISS}" | jq -r '.result.content[0].text | fromjson | .kind')"
echo "  post-edit kind=${WWA_MISS_KIND}"
[[ "${WWA_MISS_KIND}" == "pending_dispatch" ]] || { echo "  FAIL: content change should have invalidated the cache"; exit 1; }

# 29g. C1 TOCTOU guard: if the page is updated BETWEEN dispatch and
# finalize, the cache MUST be keyed to the dispatch-time snapshot,
# not the finalize-time state. Otherwise stale answers are cached
# against a newer page and the cache never re-invalidates.
WWA_MISS_ID="$(echo "${WWA_MISS}" | jq -r '.result.content[0].text | fromjson | .search_id')"
# Mutate the page mid-flight.
echo "- 2026-05-12 — mutation BETWEEN dispatch and finalize." >> "${WWA_PAGE}"
WWA_TOC_DOSS=$(jq -nc '{
  query_interpretation: "Holistic state of WWA fixture project.",
  answer: "Snapshot at dispatch time — does not include the mid-flight mutation.",
  confidence: "high",
  sources: [],
  suggested_reads: [],
  open_questions: []
}')
WWA_TOC_FIN_INPUT=$(jq -nc --arg sid "${WWA_MISS_ID}" --argjson d "${WWA_TOC_DOSS}" '{search_id:$sid, dossier:$d}')
mcp "tools/call" "${WWA_TOC_FIN_INPUT}" "brain-search-finalize" >/dev/null
# A query NOW (against the post-mutation page) MUST miss the cache
# and re-dispatch, because the cache was keyed to the dispatch-time
# snapshot, not the post-mutation page state.
WWA_TOC_QRY="$(mcp "tools/call" \
  "$(jq -nc --arg s "${WWA_SLUG}" '{query:"where are we on \($s)", intent:"where_are_we", project_slug:$s, depth:"standard"}')" \
  "brain-search")"
WWA_TOC_KIND="$(echo "${WWA_TOC_QRY}" | jq -r '.result.content[0].text | fromjson | .kind')"
echo "  TOCTOU-after-finalize kind=${WWA_TOC_KIND}"
[[ "${WWA_TOC_KIND}" == "pending_dispatch" ]] || { echo "  FAIL: TOCTOU — stale dossier should NOT be served against post-mutation page"; exit 1; }
# Positive check: the cache file's `page_content_sha256` MUST equal
# the pre-mutation sha (i.e. the dispatch-time snapshot). If a future
# refactor caused finalize to silently skip the cache write, the
# pending_dispatch result above would still satisfy the assertion but
# the cache key wouldn't be what we claim. Compute the pre-mutation
# sha by reverting the file to its post-29f state in memory.
PRE_MUTATION_SHA="$(/usr/bin/sed '$d' "${WWA_PAGE}" | shasum -a 256 | awk '{print $1}')"
CACHE_SHA="$(jq -r '.page_content_sha256' "${WWA_CACHE}")"
echo "  cache pre-mutation sha=${CACHE_SHA:0:12}…  expected=${PRE_MUTATION_SHA:0:12}…"
[[ "${CACHE_SHA}" == "${PRE_MUTATION_SHA}" ]] || { echo "  FAIL: cache key should be the dispatch-time content sha, not the finalize-time sha"; exit 1; }

echo "  where_are_we broker OK"

echo "--- 30. sweep-legacy-where-we-are (one-shot, idempotent) ---"
# Two project pages: one with substantive legacy content (must be
# archived before deletion), one with the empty placeholder (must be
# deleted without an audit file).
SUB_PAGE="${VAULT}/projects/legacy-wwa-sub.md"
EMPTY_PAGE="${VAULT}/projects/legacy-wwa-empty.md"
mkdir -p "${VAULT}/projects"
cat > "${SUB_PAGE}" <<'EOF'
---
slug: legacy-wwa-sub
last_touched: '2026-05-01T00:00:00.000Z'
status: active
---
# Legacy WWA sub

## Where we are
<!-- brain:block project.legacy-wwa-sub.where-we-are.v1 -->

- Real legacy synthesised content that must be archived, not silently deleted.

## Recent updates
<!-- brain:block project.legacy-wwa-sub.recent-updates.v1 -->

_(no entries yet)_
EOF
cat > "${EMPTY_PAGE}" <<'EOF'
---
slug: legacy-wwa-empty
last_touched: '2026-05-01T00:00:00.000Z'
status: active
---
# Legacy WWA empty

## Where we are
<!-- brain:block project.legacy-wwa-empty.where-we-are.v1 -->

_(no entries yet)_

## Recent updates
<!-- brain:block project.legacy-wwa-empty.recent-updates.v1 -->

_(no entries yet)_
EOF
SLW_OUT="$(BRAIN_VAULT_ROOT="${VAULT}" \
  "${NODE}" "${ROOT}/server/dist/librarian/cli.js" sweep-legacy-where-we-are)"
echo "  ${SLW_OUT}"
# Other smoke steps may have left legacy where-we-are blocks on
# fixture pages they created; assert this step's contribution rather
# than absolute totals to keep the assertion order-independent.
echo "${SLW_OUT}" | jq -e '
  .blocks_removed >= 2
  and .substantive_archived >= 1
  and .empty_removed >= 1
  and .errors == 0
' >/dev/null || { echo "  FAIL: counters"; exit 1; }
# Pages must no longer contain the marker.
! grep -q "brain:block project.legacy-wwa-sub.where-we-are" "${SUB_PAGE}" || { echo "  FAIL: substantive block not removed"; exit 1; }
! grep -q "brain:block project.legacy-wwa-empty.where-we-are" "${EMPTY_PAGE}" || { echo "  FAIL: empty block not removed"; exit 1; }
# Recent updates section on both pages must still be present.
grep -q "brain:block project.legacy-wwa-sub.recent-updates" "${SUB_PAGE}" || { echo "  FAIL: sub page recent-updates wiped"; exit 1; }
grep -q "brain:block project.legacy-wwa-empty.recent-updates" "${EMPTY_PAGE}" || { echo "  FAIL: empty page recent-updates wiped"; exit 1; }
# Audit file exists for the substantive page; NOT for the empty one.
[[ -f "${VAULT}/.brain/needs-review/legacy-where-we-are/legacy-wwa-sub.md" ]] || { echo "  FAIL: substantive audit missing"; exit 1; }
[[ ! -f "${VAULT}/.brain/needs-review/legacy-where-we-are/legacy-wwa-empty.md" ]] || { echo "  FAIL: empty page wrongly archived"; exit 1; }
grep -q "Real legacy synthesised content" "${VAULT}/.brain/needs-review/legacy-where-we-are/legacy-wwa-sub.md" || { echo "  FAIL: audit content missing"; exit 1; }
# Idempotency: re-run is a no-op.
SLW_OUT2="$(BRAIN_VAULT_ROOT="${VAULT}" \
  "${NODE}" "${ROOT}/server/dist/librarian/cli.js" sweep-legacy-where-we-are)"
echo "${SLW_OUT2}" | jq -e '.blocks_removed == 0' >/dev/null \
  || { echo "  FAIL: re-run wasn't idempotent"; exit 1; }
echo "  legacy-where-we-are sweep OK"

CAPTURE_POST_COUNT="$(/bin/ls "${VAULT}/captures" 2>/dev/null | wc -l | tr -d ' ')"
echo "---"
echo "captures: ${CAPTURE_PRE_COUNT} -> ${CAPTURE_POST_COUNT}"
echo "smoke test passed."
