#!/usr/bin/env bash
# brain — PreToolUse Write/Edit/MultiEdit/Bash guard.
#
# Blocks any direct write under the synthesized planes:
#   ~/brain/profile/, projects/, feed/, knowledge/, index.md,
#   log.md, .brain/provenance/, .brain/db/.
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
sacred_subpaths=(
  "profile"
  "projects"
  "feed"
  "knowledge"
  "index.md"
  "log.md"
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
    # `>[^&]` matches `>file`, `> file`, `>>file`, `&>file`, `2>file`
    # — but NOT `>&fd` style stderr-merge redirects (e.g. `2>&1`,
    # `1>&2`, `>&-`), which are not writes to a path.
    write_tokens_re='(>[^&]|[[:space:]]tee[[:space:]]|^tee[[:space:]]|[[:space:]]rm[[:space:]]|^rm[[:space:]]|[[:space:]]mv[[:space:]]|^mv[[:space:]]|[[:space:]]cp[[:space:]]|^cp[[:space:]]|sed -i|sed --in-place|truncate|dd of=|chmod[[:space:]]|chown[[:space:]])'
    if [[ "${command}" =~ ${write_tokens_re} ]]; then
      block_reason="bash write to sacred path '${matched_path}'"
    fi
  fi
fi

if [[ -n "${block_reason}" ]]; then
  echo "brain: refusing ${block_reason}." >&2
  echo "       Synthesized planes are librarian-owned. Use the brain-capture" >&2
  echo "       MCP tool — agents do not write directly to projects/, feed/," >&2
  echo "       knowledge/, profile/, index.md, log.md, or .brain/." >&2
  echo "       (tool=${tool_name})" >&2
  exit 2
fi

exit 0
