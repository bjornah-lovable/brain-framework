#!/usr/bin/env bash
# Fake `claude` binary for the brain-capture-delta classifier in
# smoke tests. Drains stdin, emits a canned valid-schema JSON
# envelope on stdout (mirroring `--output-format json`), and exits 0.
#
# Outcome is controlled by env BRAIN_FAKE_DELTA_OUTCOME (default
# CAPTURE_CREATED). For NO_RELEVANT_INFORMATION / ALREADY_CAPTURED
# the body and slug fields are omitted.

OUTCOME="${BRAIN_FAKE_DELTA_OUTCOME:-CAPTURE_CREATED}"
# When BRAIN_FAKE_DELTA_REQUIRES_CAPTURES=1, the fake checks whether
# the stdin payload included a non-empty RECENT_CAPTURES_FOR_SESSION
# section and overrides the outcome to ALREADY_CAPTURED if so. This
# lets the smoke test verify the preamble actually reaches the
# classifier.
REQUIRE_CAPTURES="${BRAIN_FAKE_DELTA_REQUIRES_CAPTURES:-}"
SLUG="${BRAIN_FAKE_SLUG:-brain-deltatest}"
KIND="${BRAIN_FAKE_KIND:-finding}"

STDIN_BUF="$(cat)"
if [[ "${REQUIRE_CAPTURES}" == "1" ]]; then
  # Extract the lines between RECENT_CAPTURES_FOR_SESSION: and the
  # next TRANSCRIPT_DELTA: and inspect only those — the prompt file
  # itself documents the literal `(no prior captures for this session)`
  # marker, so grepping the whole stdin gives a false negative.
  PREAMBLE_BLOCK=$(echo "${STDIN_BUF}" | /usr/bin/awk '
    /^RECENT_CAPTURES_FOR_SESSION:/ { in_block = 1; next }
    /^TRANSCRIPT_DELTA:/ { in_block = 0 }
    in_block { print }
  ')
  if [[ -n "${PREAMBLE_BLOCK}" ]] \
     && ! echo "${PREAMBLE_BLOCK}" | grep -qE '\(no prior captures for this session\)'; then
    OUTCOME="ALREADY_CAPTURED"
  fi
fi
BODY=$(cat <<EOF
## Findings
- Delta-classifier round-trip verified: brain-capture.sh dispatches the headless classifier and writes the resulting capture via the brain-librarian capture CLI.
EOF
)

# Optional cost stub — when BRAIN_FAKE_COST_USD / BRAIN_FAKE_IN_TOKENS /
# BRAIN_FAKE_OUT_TOKENS are set, embed them in the envelope so the
# capture worker's accumulate_cost helper sees realistic numbers.
COST_STUB=""
COST_USD="${BRAIN_FAKE_COST_USD:-}"
IN_TOK="${BRAIN_FAKE_IN_TOKENS:-}"
OUT_TOK="${BRAIN_FAKE_OUT_TOKENS:-}"
if [[ -n "${COST_USD}" || -n "${IN_TOK}" || -n "${OUT_TOK}" ]]; then
  COST_STUB=$(BRAIN_COST="${COST_USD:-0}" BRAIN_IN="${IN_TOK:-0}" BRAIN_OUT="${OUT_TOK:-0}" /usr/bin/python3 - <<'PY'
import json, os
print(json.dumps({
  "total_cost_usd": float(os.environ["BRAIN_COST"]),
  "usage": {
    "input_tokens": int(os.environ["BRAIN_IN"]),
    "output_tokens": int(os.environ["BRAIN_OUT"]),
    "cache_read_input_tokens": 0,
  },
}))[1:-1]
PY
)
  COST_STUB=",${COST_STUB}"
fi

if [[ "${OUTCOME}" == "NO_RELEVANT_INFORMATION" || "${OUTCOME}" == "ALREADY_CAPTURED" ]]; then
  cat <<EOF
{"type":"result","subtype":"success","is_error":false,"result":"{\"outcome\":\"${OUTCOME}\",\"reason\":\"fake classifier — no body needed\"}"${COST_STUB}}
EOF
  exit 0
fi

# CAPTURE_CREATED / QUARANTINED — embed body+slug. The body comes
# back as a JSON-stringified inner object inside the .result field
# (matches what real claude returns under --output-format json).
INNER=$(BRAIN_OUTCOME="${OUTCOME}" BRAIN_SLUG="${SLUG}" \
  BRAIN_KIND="${KIND}" BRAIN_BODY="${BODY}" /usr/bin/python3 - <<'PY'
import json, os
print(json.dumps({
  "outcome": os.environ["BRAIN_OUTCOME"],
  "reason": "fake classifier — canned body for smoke test",
  "body": os.environ["BRAIN_BODY"],
  "project_slug": os.environ["BRAIN_SLUG"],
  "capture_kind": os.environ["BRAIN_KIND"],
  "importance": "medium",
  "confidence": "high",
}))
PY
)

ENVELOPE=$(BRAIN_INNER="${INNER}" \
  BRAIN_COST="${COST_USD:-0}" \
  BRAIN_IN="${IN_TOK:-0}" \
  BRAIN_OUT="${OUT_TOK:-0}" \
  BRAIN_HAS_COST="${COST_STUB:+1}" \
  /usr/bin/python3 - <<'PY'
import json, os
env = {
  "type": "result",
  "subtype": "success",
  "is_error": False,
  "result": os.environ["BRAIN_INNER"],
}
if os.environ.get("BRAIN_HAS_COST"):
    env["total_cost_usd"] = float(os.environ["BRAIN_COST"])
    env["usage"] = {
        "input_tokens": int(os.environ["BRAIN_IN"]),
        "output_tokens": int(os.environ["BRAIN_OUT"]),
        "cache_read_input_tokens": 0,
    }
print(json.dumps(env))
PY
)
printf '%s\n' "${ENVELOPE}"
