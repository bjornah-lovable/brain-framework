<!--
This is the always-loaded brain baseline. The install script wraps the
content below with the BRAIN_BASELINE_BEGIN / BRAIN_BASELINE_END sentinels
in ~/.claude/CLAUDE.md. Re-running install-baseline.sh replaces the
wrapped section in place, so updates here propagate.

The full mechanics (tools reference, planes/cadence, capture rubric,
dispatch protocol, brain-editing rules) live in ~/.claude/brain-usage.md
— a sibling doc the agent reads on demand. Keep this baseline section
short (unconditional discipline only); detail belongs in brain-usage.md.
-->

<!-- BRAIN_BASELINE_BEGIN -->
## Personal brain (`~/brain/`)

A markdown vault accessed via MCP tools (`brain-read`, `brain-search`,
`brain-capture`). Your operating memory: decisions, findings, blockers,
project state. Both Claude Code and Codex are full readers and writers,
governed by the same discipline below.

**Discipline (unconditional, both harnesses):**

- Session start: call `brain-read` on `profile/me.md` once and treat
  it as ground rules.
- Before any non-trivial action (investigation, design, code change,
  plan, draft) and before any web search: `brain-search` first. If
  nothing matches, say so; silence isn't a check.
- Capture decisions, confirmed findings, blockers, and project state
  changes via `brain-capture` at natural stopping points. Skip routine
  iteration and anything obvious from artifacts.
- **Never write directly to `projects/`, `profile/`, `index.md`,
  `log.md`, `recent.md`, or `.brain/`.** Only `captures/` via
  `brain-capture`. The librarian is the sole writer of synthesised
  planes; you write captures and the librarian consolidates them. A
  `PreToolUse` hook (`sacred-paths-guard.sh`) is wired identically in
  both harnesses, and the MCP server enforces its own write boundary
  as defence-in-depth.
- `brain-librarian-*` tools are operator flows (consolidate /
  synthesise / import), not part of routine capture. Don't call them
  in normal work.

Full mechanics (tools reference, planes/cadence, capture rubric, dispatch
protocol, brain-editing rules) in **`~/.claude/brain-usage.md`**.
<!-- BRAIN_BASELINE_END -->
