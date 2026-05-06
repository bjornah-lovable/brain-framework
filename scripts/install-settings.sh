#!/usr/bin/env bash
#
# ╔══════════════════════════════════════════════════════════════════╗
# ║  STOP — read ~/brain/code/AGENTS.md before editing this script.  ║
# ║  Hooks + MCP server registration are managed here. Don't         ║
# ║  hand-edit ~/.claude/settings.json directly for brain entries —  ║
# ║  add the change here and re-run, so other machines pick it up.   ║
# ╚══════════════════════════════════════════════════════════════════╝
#
# Merge brain entries into ~/.claude/settings.json without replacing
# existing hook entries (Corridor, kjell, tmux, etc.).
#
# - mcpServers.brain is set (overwrite-safe; we own that key).
# - hooks.PreToolUse, hooks.PreCompact, hooks.SessionEnd each append
#   the brain entry if absent. Re-running updates the matcher in place
#   if the snippet's matcher has drifted.
#
# Idempotent: running twice does not duplicate entries.
#
# A backup of the existing settings.json is written next to it before
# any change.

set -euo pipefail

SETTINGS="${HOME}/.claude/settings.json"
SNIPPET="$(cd "$(dirname "$0")" && pwd)/../hooks/settings-snippet.json"

if [[ ! -f "${SNIPPET}" ]]; then
  echo "missing: ${SNIPPET}" >&2
  exit 1
fi

mkdir -p "${HOME}/.claude"
if [[ ! -f "${SETTINGS}" ]]; then
  echo '{}' > "${SETTINGS}"
fi

ts="$(date +%Y%m%d-%H%M%S)"
cp "${SETTINGS}" "${SETTINGS}.bak.${ts}"

/usr/bin/python3 - "$SETTINGS" "$SNIPPET" <<'PY'
import json
import sys
from pathlib import Path

settings_path = Path(sys.argv[1])
snippet_path = Path(sys.argv[2])

settings = json.loads(settings_path.read_text())
snippet = json.loads(snippet_path.read_text())

# 1. mcpServers.brain — set or overwrite our key only.
mcp = settings.setdefault("mcpServers", {})
mcp["brain"] = snippet["mcpServers"]["brain"]

# 2. Hooks — for every event we ship, idempotently merge our entry.
hooks = settings.setdefault("hooks", {})


def has_brain_entry(entries, expected_cmd, expected_matcher):
    for e in entries:
        for h in e.get("hooks", []):
            if h.get("type") == "command" and h.get("command") == expected_cmd:
                # Found our entry. Matcher drift (e.g. v3 widening from
                # Write|Edit|MultiEdit to also include Bash) is updated in
                # place so re-running picks up changes.
                if expected_matcher is not None and e.get("matcher") != expected_matcher:
                    e["matcher"] = expected_matcher
                return True
    return False


for event_name, brain_entries in snippet.get("hooks", {}).items():
    target = hooks.setdefault(event_name, [])
    for brain_entry in brain_entries:
        cmd = brain_entry["hooks"][0]["command"]
        matcher = brain_entry.get("matcher")  # None for events without matcher
        if not has_brain_entry(target, cmd, matcher):
            target.append(brain_entry)

settings_path.write_text(json.dumps(settings, indent=2) + "\n")
print(f"updated: {settings_path}")
PY
