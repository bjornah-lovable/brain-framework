#!/usr/bin/env bash
# Install or update the brain baseline section in ~/.claude/CLAUDE.md.
#
# Idempotent across re-runs and across baseline content changes:
#   1. If sentinel markers (<!-- BRAIN_BASELINE_BEGIN/END -->) are
#      present, replace everything between them with the current
#      canonical content. (Updates propagate.)
#   2. Else if a pre-sentinel install is detected (the section heading
#      "## Personal brain" exists without sentinels), splice out the
#      old section by walking from that heading to the next "## "
#      heading (or EOF) and replace it with the canonical content.
#   3. Else, append the canonical content at EOF.
#
# Always writes a timestamped backup before modifying.

set -euo pipefail

CLAUDE_MD="${HOME}/.claude/CLAUDE.md"
BASELINE="$(cd "$(dirname "$0")" && pwd)/../hooks/claude-md-baseline.md"
HEADING_MARKER='## Personal brain (`~/brain/`)'
BEGIN_MARKER='<!-- BRAIN_BASELINE_BEGIN -->'
END_MARKER='<!-- BRAIN_BASELINE_END -->'

if [[ ! -f "${CLAUDE_MD}" ]]; then
  echo "missing: ${CLAUDE_MD}" >&2
  exit 1
fi
if [[ ! -f "${BASELINE}" ]]; then
  echo "missing: ${BASELINE}" >&2
  exit 1
fi

ts="$(date +%Y%m%d-%H%M%S)"
cp "${CLAUDE_MD}" "${CLAUDE_MD}.bak.${ts}"

CLAUDE_MD="${CLAUDE_MD}" BASELINE="${BASELINE}" \
HEADING_MARKER="${HEADING_MARKER}" \
BEGIN_MARKER="${BEGIN_MARKER}" END_MARKER="${END_MARKER}" \
/usr/bin/python3 - <<'PY'
import os
from pathlib import Path

target = Path(os.environ["CLAUDE_MD"])
baseline_path = Path(os.environ["BASELINE"])
heading = os.environ["HEADING_MARKER"]
begin = os.environ["BEGIN_MARKER"]
end = os.environ["END_MARKER"]

current = target.read_text()
baseline_full = baseline_path.read_text()

# Extract the wrapped block from the canonical baseline. The baseline
# file leads with a top-of-file HTML comment that should not be
# spliced into CLAUDE.md.
b_start = baseline_full.find(begin)
b_end = baseline_full.find(end)
if b_start == -1 or b_end == -1 or b_end < b_start:
    raise SystemExit(
        f"baseline file missing sentinels: {baseline_path}"
    )
canonical = baseline_full[b_start : b_end + len(end)].rstrip() + "\n"

# Path 1: sentinels already present — replace between them.
c_start = current.find(begin)
c_end = current.find(end)
if c_start != -1 and c_end != -1 and c_end > c_start:
    new = (
        current[:c_start].rstrip()
        + "\n\n"
        + canonical
        + "\n"
        + current[c_end + len(end) :].lstrip()
    )
    if new == current:
        print(f"already current in {target} — no changes")
    else:
        target.write_text(new)
        print(f"updated wrapped baseline in {target}")
    raise SystemExit(0)

# Path 2: pre-sentinel install — splice out the old section by
# heading and replace with the canonical (sentinel-wrapped) content.
heading_idx = current.find(heading)
if heading_idx != -1:
    # Walk back to the start of the heading line.
    line_start = current.rfind("\n", 0, heading_idx)
    line_start = 0 if line_start == -1 else line_start + 1

    # Walk forward to the next top-level "## " heading (or EOF).
    after = current.find("\n## ", heading_idx + len(heading))
    section_end = len(current) if after == -1 else after + 1  # include leading \n

    head = current[:line_start].rstrip()
    tail = current[section_end:]
    new = head + "\n\n" + canonical + ("\n" + tail.lstrip() if tail.strip() else "\n")
    target.write_text(new)
    print(f"migrated pre-sentinel baseline → wrapped section in {target}")
    raise SystemExit(0)

# Path 3: clean append.
sep = "\n\n" if not current.endswith("\n\n") else ""
target.write_text(current.rstrip() + "\n\n" + canonical + "\n")
print(f"appended baseline to {target}")
PY

echo "backup: ${CLAUDE_MD}.bak.${ts}"
