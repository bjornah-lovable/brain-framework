#!/usr/bin/env bash
# brain — Anthropic API key helper.
#
# Invoked by `claude --bare` via the `apiKeyHelper` field in a
# settings JSON file. Reads ANTHROPIC_API_KEY from a private file
# under the vault and prints just the key value to stdout.
#
# The key never enters Bjorn's shell env, never shows up in `ps`,
# never lands in shell history. It is read fresh by this helper on
# every spawn, lives in memory only for the duration of the helper
# process, and is piped directly to claude.
#
# File: ${HOME}/brain/.brain/secrets/.env.local (chmod 600)
# Format: standard shell key=value, e.g.
#   ANTHROPIC_API_KEY=sk-ant-...
#
# Exit codes:
#   0 — key printed to stdout.
#   1 — file missing or key not set; error message on stderr.

set -euo pipefail

SECRETS_FILE="${BRAIN_SECRETS_FILE:-${HOME}/brain/.brain/secrets/.env.local}"

if [[ ! -f "${SECRETS_FILE}" ]]; then
  echo "anthropic-key-helper: missing ${SECRETS_FILE}" >&2
  echo "  run ~/brain/code/scripts/setup-anthropic-key.sh to provision" >&2
  exit 1
fi

# Refuse to read a world-readable secrets file. Silent leakage is
# the worst failure mode here; force the user to chmod 600.
perms="$(/usr/bin/stat -f '%Lp' "${SECRETS_FILE}" 2>/dev/null || /usr/bin/stat -c '%a' "${SECRETS_FILE}" 2>/dev/null || echo '')"
if [[ -n "${perms}" && "${perms}" != "600" && "${perms}" != "400" ]]; then
  echo "anthropic-key-helper: ${SECRETS_FILE} permissions ${perms} too open; require 600" >&2
  exit 1
fi

# Source the file in a subshell so its variables never escape into
# anything else. Print only the value of ANTHROPIC_API_KEY, no name.
key="$(/bin/bash -c "set -a; . '${SECRETS_FILE}'; printf '%s' \"\${ANTHROPIC_API_KEY:-}\"")"

if [[ -z "${key}" ]]; then
  echo "anthropic-key-helper: ANTHROPIC_API_KEY not set in ${SECRETS_FILE}" >&2
  exit 1
fi

printf '%s' "${key}"
