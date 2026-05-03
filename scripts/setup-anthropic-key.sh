#!/usr/bin/env bash
# brain — one-time provisioning of the Anthropic API key for
# `claude --bare` spawns. Writes ~/brain/.brain/secrets/.env.local
# (chmod 600) so the apiKeyHelper script can read it.
#
# Idempotent: re-running prompts to overwrite an existing key.

set -euo pipefail

SECRETS_DIR="${HOME}/brain/.brain/secrets"
SECRETS_FILE="${SECRETS_DIR}/.env.local"
HELPER="${HOME}/brain/code/scripts/anthropic-key-helper.sh"
SETTINGS="${HOME}/brain/.brain/settings-bare.json"

mkdir -p "${SECRETS_DIR}"
chmod 700 "${SECRETS_DIR}"

if [[ -f "${SECRETS_FILE}" ]]; then
  echo "An existing key is already configured at ${SECRETS_FILE}."
  read -r -p "Overwrite? [y/N] " ans
  case "${ans}" in
    y|Y|yes|YES) ;;
    *) echo "aborted; existing key left in place"; exit 0 ;;
  esac
fi

echo
echo "Paste the Anthropic API key (input is hidden). Get one at"
echo "https://console.anthropic.com/settings/keys."
read -r -s -p "ANTHROPIC_API_KEY: " key
echo

if [[ -z "${key}" ]]; then
  echo "no key entered; aborting" >&2
  exit 1
fi

if [[ "${key}" != sk-ant-* ]]; then
  echo "warning: key does not start with 'sk-ant-'; storing anyway" >&2
fi

# Write atomically.
tmp="$(mktemp "${SECRETS_DIR}/.env.local.XXXXXX")"
printf 'ANTHROPIC_API_KEY=%s\n' "${key}" > "${tmp}"
chmod 600 "${tmp}"
mv "${tmp}" "${SECRETS_FILE}"

# Verify by round-tripping through the helper.
got="$("${HELPER}")"
if [[ "${got}" != "${key}" ]]; then
  echo "verification failed: helper did not return the stored key" >&2
  exit 1
fi

echo "key stored at ${SECRETS_FILE} (chmod 600)"
echo "helper:   ${HELPER}"
echo "settings: ${SETTINGS}"
echo
echo "brain spawns of \`claude --bare\` will now authenticate via apiKeyHelper."
