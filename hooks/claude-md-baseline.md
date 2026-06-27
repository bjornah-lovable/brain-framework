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

A markdown vault accessed via MCP tools (`mcp__brain__brain-*`). Your
operating memory — decisions, findings, blockers, project state.

**Discipline (unconditional):**

- Session start: call `mcp__brain__brain-read` on `profile/me.md` once
  and treat it as ground rules.
- Before any non-trivial action (investigation, design, code change,
  plan, draft) and before any web search: `mcp__brain__brain-search`
  first. If nothing matches, say so — silence isn't a check.
- Capture decisions, confirmed findings, blockers, and project state
  changes via `mcp__brain__brain-capture` at natural stopping points.
  Skip routine iteration and anything obvious from artifacts.
- **Never write directly to `projects/` or `profile/`.** Only `captures/`
  via `mcp__brain__brain-capture`. A `PreToolUse` hook blocks direct
  writes anyway.

Full mechanics — tools reference, planes/cadence, capture rubric, dispatch
protocol, brain-editing rules — in **`~/.claude/brain-usage.md`**.
<!-- BRAIN_BASELINE_END -->
