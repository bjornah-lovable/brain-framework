#!/usr/bin/env bash
# brain — PreToolUse Write/Edit/MultiEdit/Bash guard.
#
# Blocks any direct write under the sacred paths:
#   ~/brain/profile/, projects/, index.md, log.md, recent.md,
#   .brain/provenance/, .brain/db/.
# (`feed/` retired 2026-05-15, `knowledge/` retired 2026-06-27.)
#
# Claude Code passes the tool input as JSON on stdin. We extract the
# candidate path (Write/Edit/MultiEdit) or the command string (Bash),
# realpath-resolve the path, and check sacred plane membership.
#
# Bash inspection is heuristic — accidental safety, not adversarial.
# A determined script (e.g. python that opens the file, sed via piped
# stdin) can still bypass it. The MCP server enforces its own write
# boundary in code; this hook is defense-in-depth.
#
# Exit codes (per Claude Code docs):
#   0 → allow.
#   2 → block. stderr is shown to the agent.
#   anything else → non-blocking error; the tool runs anyway.

set -uo pipefail

VAULT_ROOT="${BRAIN_VAULT_ROOT:-${HOME}/brain}"

# Track both the literal path and its realpath form. macOS and Linux
# both have /var → /private/var (or other) symlinks; bash commands
# typically reference the literal form, but realpath checks against
# the resolved form. Substring-match against either.
VAULT_ROOT_LITERAL="${VAULT_ROOT}"
VAULT_ROOT_REAL="${VAULT_ROOT}"
if [[ -e "${VAULT_ROOT}" ]]; then
  VAULT_ROOT_REAL="$(/usr/bin/python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "${VAULT_ROOT}")"
fi

# Build SACRED with both literal and (when different) real forms.
# `feed/` retired 2026-05-15, `knowledge/` retired 2026-06-27 (see
# SCHEMA.md "Retired planes"); neither plane exists, no guard needed.
sacred_subpaths=(
  "profile"
  "projects"
  "index.md"
  "log.md"
  "recent.md"
  ".brain/provenance"
  ".brain/db"
)
SACRED=()
for sub in "${sacred_subpaths[@]}"; do
  SACRED+=("${VAULT_ROOT_LITERAL}/${sub}")
  if [[ "${VAULT_ROOT_REAL}" != "${VAULT_ROOT_LITERAL}" ]]; then
    SACRED+=("${VAULT_ROOT_REAL}/${sub}")
  fi
done

input="$(cat)"

# Extract tool_name, file_path, command from the JSON input.
# Outputs three lines: tool_name, file_path, command. Missing fields
# are emitted as empty lines.
parsed="$(/usr/bin/python3 - "$input" <<'PY'
import json
import sys

try:
    data = json.loads(sys.argv[1])
except Exception:
    print()
    print()
    print()
    sys.exit(0)

tool_name = data.get("tool_name") or ""
ti = data.get("tool_input") or {}
file_path = ti.get("file_path") or ti.get("path") or ""
command = ti.get("command") or ""

print(tool_name)
print(file_path)
print(command)
PY
)"

tool_name="$(echo "${parsed}" | /usr/bin/sed -n 1p)"
file_path="$(echo "${parsed}" | /usr/bin/sed -n 2p)"
command="$(echo "${parsed}" | /usr/bin/sed -n 3p)"

block_reason=""

# Resolve the candidate path for Write/Edit/MultiEdit.
if [[ -n "${file_path}" ]]; then
  parent="$(/usr/bin/dirname "${file_path}")"
  if [[ -d "${parent}" ]]; then
    parent_real="$(/usr/bin/python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "${parent}")"
    base="$(/usr/bin/basename "${file_path}")"
    resolved="${parent_real}/${base}"
  else
    resolved="${file_path}"
  fi
  for s in "${SACRED[@]}"; do
    if [[ "${resolved}" == "${s}" || "${resolved}" == "${s}/"* ]]; then
      block_reason="direct write to '${resolved}'"
      break
    fi
  done
fi

# Heuristic Bash inspection. Block only when the command both:
#   (a) references a sacred path (absolute or via ~), AND
#   (b) contains a write-shaped token (redirect, mv/cp/rm/tee/sed -i, etc.).
# Reads (cat / git diff / less / grep) flow through unblocked.
if [[ -z "${block_reason}" && -n "${command}" ]]; then
  has_sacred_ref=""
  matched_path=""
  HOME_TILDE="${HOME}"
  for s in "${SACRED[@]}"; do
    rel_tilde="~/${s#${HOME_TILDE}/}"
    if [[ "${command}" == *"${s}"* || "${command}" == *"${rel_tilde}"* ]]; then
      has_sacred_ref="yes"
      matched_path="${s}"
      break
    fi
  done

  if [[ -n "${has_sacred_ref}" ]]; then
    # Redirects whose target is NOT a sacred path are fine. Strip them
    # before checking — otherwise `ls ~/brain/projects 2>/dev/null` or
    # `find ~/brain/captures > /tmp/x` false-positive as writes.
    #
    # We delete every `… >[>]?  <token>` redirect from the command,
    # but only if <token> does NOT contain a sacred-path substring.
    # Then we apply the write-shape regex to the remainder.
    pruned_command="${command}"
    while IFS= read -r tgt; do
      # Skip targets that themselves contain a sacred ref — those are
      # the ones we DO want to block.
      keep=""
      for s in "${SACRED[@]}"; do
        rel_tilde="~/${s#${HOME_TILDE}/}"
        if [[ "${tgt}" == *"${s}"* || "${tgt}" == *"${rel_tilde}"* ]]; then
          keep="yes"; break
        fi
      done
      if [[ -z "${keep}" ]]; then
        # Remove a single occurrence of the redirect from the pruned
        # command. Match `[fd]?[>]+ *<tgt>` where tgt is the exact text.
        # Escape regex special chars in the target before substitution.
        esc="$(/usr/bin/python3 -c 'import re,sys; print(re.escape(sys.argv[1]))' "${tgt}")"
        pruned_command="$(/usr/bin/python3 -c 'import re,sys; pat=r"[0-9]?>>?\s*"+sys.argv[1]; print(re.sub(pat, "", sys.argv[2], count=1))' "${esc}" "${pruned_command}")"
      fi
    done < <(/usr/bin/python3 -c 'import re,sys
m = re.findall(r"[0-9]?>>?\s*(\S+)", sys.argv[1])
for t in m: print(t)' "${command}")

    # `>[^&]` matches `>file`, `> file`, `>>file`, `&>file`, `2>file`
    # — but NOT `>&fd` style stderr-merge redirects (e.g. `2>&1`,
    # `1>&2`, `>&-`), which are not writes to a path. Applied AFTER
    # pruning non-sacred redirect targets above.
    write_tokens_re='(>[^&]|[[:space:]]tee[[:space:]]|^tee[[:space:]]|[[:space:]]rm[[:space:]]|^rm[[:space:]]|[[:space:]]mv[[:space:]]|^mv[[:space:]]|[[:space:]]cp[[:space:]]|^cp[[:space:]]|sed -i|sed --in-place|truncate|dd of=|chmod[[:space:]]|chown[[:space:]])'
    if [[ "${pruned_command}" =~ ${write_tokens_re} ]]; then
      block_reason="bash write to sacred path '${matched_path}'"
    fi
  fi
fi

if [[ -n "${block_reason}" ]]; then
  echo "brain: refusing ${block_reason}." >&2
  echo "       projects/ is librarian-owned. Use the brain-capture" >&2
  echo "       MCP tool — agents do not write directly to projects/," >&2
  echo "       profile/, index.md, log.md, recent.md, or .brain/." >&2
  echo "       (tool=${tool_name})" >&2
  exit 2
fi

exit 0
