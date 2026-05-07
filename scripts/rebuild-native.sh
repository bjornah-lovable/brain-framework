#!/usr/bin/env bash
# Rebuild the better-sqlite3 native binding against the brain's
# canonical Node (the same binary scripts/brain-node execs).
#
# Why a dedicated script, not `pnpm rebuild`:
#   On this machine pnpm/npm/npx all shebang `#!/usr/bin/env node` and
#   PATH resolves to the nix-shipped Node, while the brain's canonical
#   Node is the one scripts/brain-node selects (default
#   /opt/homebrew/bin/node). Rebuilding through pnpm picks the wrong
#   Node, produces a binding for the wrong NODE_MODULE_VERSION, and
#   the launchd synthesize job fails on load — which stalled the
#   librarian for a day in 2026-05. This script invokes node-gyp
#   directly under brain-node so the binding always matches.
#
# Run after upgrading whichever Node brain-node points at (e.g. after
# `brew upgrade node`).

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BRAIN_NODE="$ROOT/scripts/brain-node"

if [[ ! -x "$BRAIN_NODE" ]]; then
  echo "rebuild-native: $BRAIN_NODE not executable" >&2
  exit 1
fi

# Ask brain-node which Node it actually execs, so we hit node-gyp with
# the *same* binary the runtime uses. The wrapper's ABI fail-fast is
# bypassed via BRAIN_NODE_SKIP_ABI_CHECK so a stale stamp doesn't block
# the rebuild that will refresh it.
NODE_BIN="$(BRAIN_NODE_SKIP_ABI_CHECK=1 "$BRAIN_NODE" -e 'process.stdout.write(process.execPath)')"

# Resolve better-sqlite3 dynamically — surviving version bumps.
BS3_DIR="$("$NODE_BIN" -e '
  const path = require("path");
  const pkg = require.resolve("better-sqlite3/package.json", { paths: ["'"$ROOT"'"] });
  process.stdout.write(path.dirname(pkg));
' 2>/dev/null || true)"

if [[ -z "$BS3_DIR" || ! -d "$BS3_DIR" ]]; then
  echo "rebuild-native: cannot resolve better-sqlite3 from $ROOT" >&2
  echo "  run \`pnpm install --ignore-scripts\` first" >&2
  exit 1
fi

# Avoid npx — npx itself shebangs `#!/usr/bin/env node` and would
# silently re-pin to whatever node is first on PATH.
NODE_GYP_BIN="$ROOT/node_modules/.bin/node-gyp"
if [[ ! -x "$NODE_GYP_BIN" ]]; then
  CACHED="$(ls -d "$HOME/.npm/_npx/"*/node_modules/.bin/node-gyp 2>/dev/null | head -1 || true)"
  if [[ -z "$CACHED" ]]; then
    echo "rebuild-native: node-gyp not found in $ROOT/node_modules/.bin or npx cache" >&2
    NPM_CLI="$("$NODE_BIN" -p 'try { require.resolve("npm/bin/npm-cli.js") } catch { "" }' 2>/dev/null)"
    if [[ -n "$NPM_CLI" ]]; then
      echo "  install once with: $BRAIN_NODE $NPM_CLI install -g node-gyp" >&2
    else
      echo "  install npm globally first, then \`$BRAIN_NODE \$(which npm) install -g node-gyp\`" >&2
    fi
    exit 1
  fi
  NODE_GYP_BIN="$CACHED"
fi

echo "rebuild-native: using $NODE_BIN ($("$NODE_BIN" --version))"
echo "rebuild-native: rebuilding $(basename "$BS3_DIR") at $BS3_DIR"

cd "$BS3_DIR"
"$NODE_BIN" "$NODE_GYP_BIN" rebuild --release

echo "rebuild-native: smoke-testing the binding"
BS3_PATH="$BS3_DIR" "$NODE_BIN" -e '
  const D = require(process.env.BS3_PATH);
  const db = new D(":memory:");
  if (db.prepare("SELECT 1 v").get().v !== 1) process.exit(1);
'

# Stamp the ABI so brain-node can fail-fast on Node upgrades that
# would re-introduce the original NODE_MODULE_VERSION mismatch.
ABI="$("$NODE_BIN" -p 'process.versions.modules')"
echo "$ABI" > "$ROOT/scripts/.canonical-abi"
echo "rebuild-native: stamped scripts/.canonical-abi = $ABI"

echo "rebuild-native: ok"
