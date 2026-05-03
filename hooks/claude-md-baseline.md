<!--
This is the always-loaded brain baseline. The install script wraps
the content below with the BRAIN_BASELINE_BEGIN / BRAIN_BASELINE_END
sentinels in ~/.claude/CLAUDE.md. Re-running install-baseline.sh
replaces the wrapped section in place, so updates here propagate.
-->

<!-- BRAIN_BASELINE_BEGIN -->
## Personal brain (`~/brain/`)

You have access to a personal **brain** — a markdown vault Bjorn maintains
as agent operating memory. It's an MCP server, not a context dump. You
read and write through tools, not through general filesystem access.

### Planes

| Plane | Answers | Cadence |
|---|---|---|
| `projects/` | "Where are we on X?" — including projects untouched for weeks | Sub-daily, per project |
| `feed/` | "What happened today / what should I bring to standup?" | Daily |
| `knowledge/topics/` | "What do we know about Y, across projects?" | Slow (per ingest) |
| `profile/` | "Who is Bjorn / how does he write?" | Bjorn-edited, sacred |
| `raw/` | Immutable inputs that other planes cite | Append-only |

### Read `profile/me.md` once per session

At the start of any session where you'll act on Bjorn's behalf, call
`mcp__brain__read` on `profile/me.md` and treat the contents as ground
rules. One read per session; the file is small.

### Tools

| Tool | When |
|---|---|
| `mcp__brain__search` | Default first action for "where are we / what do we know about / why did we decide". Returns a compact dossier. Use `depth=fast` for navigation, `standard` for most questions, `deep` only when archaeology is required. |
| `mcp__brain__read` | After search, fetch one or two specific pages or blocks. |
| `mcp__brain__read_provenance` | When a page's claim looks wrong or stale — see which captures fed which sections. |
| `mcp__brain__capture` | Write a tight summary at natural stopping points: a decision, a confirmed finding, a blocker, a project state change. |
| `mcp__brain__ingest` | Drop a file into `raw/imports/` for the librarian to absorb into knowledge topics. |
| `mcp__brain__index` / `mcp__brain__status` | Directory + operational state. |

### Discipline

- **Always check every source where relevant material may be.** The brain
  and the codebase are *parallel* sources of truth, not alternatives —
  the brain captures narrative state and intent; the codebase is ground
  truth for what actually exists. Read both when both are relevant.
- Before web search or invention: `mcp__brain__search`.
- "Where are we on X" → search the brain AND check git log / current
  state of the relevant code.
- **Capture rubric** — call `brain-capture` if any of:
  - a **decision** future sessions need to know about, with rationale
  - a **finding** confirmed (especially surprising ones)
  - a **blocker / open question** that affects "where we are"
  - a **state change** the project page should reflect

  Do **NOT** capture: routine tool-call iteration, drafting, chitchat,
  things obvious from artifacts (commits, PRs, file changes), or
  generalisations rederivable next time.

  **If nothing worth capturing has occurred, capture nothing.**
- **Never write directly to `projects/`, `feed/`, `knowledge/`, `profile/`.**
  The librarian is the sole writer to synthesized planes; agents write
  only to `captures/` via `brain-capture`. A `PreToolUse` hook will
  block direct writes anyway.

### Brain dispatch protocol (when MCP returns `pending_dispatch` or `pending_synthesis`)

When `mcp__brain__search` returns `kind: "pending_dispatch"` (i.e. depth=standard/deep
with non-empty candidates and you're in a CC session), use your **Task** tool —
`subagent_type: "general-purpose"` — to run the supplied `prompt`. The subagent
must return only JSON matching the supplied `schema`. Pass that JSON back via
`mcp__brain__search_finalize(search_id, dossier)`. If the subagent fails or you
decline to dispatch, the `fallback_dossier` field is the deterministic-fast result
you can use directly without finalizing.

When `mcp__brain__librarian_plan_synthesis` returns a non-empty `pending_synthesis`
array, dispatch one Task subagent per entry **in parallel** (multiple Task calls in
one assistant turn). Each subagent's output is a JSON object matching that entry's
`schema`. Collect them and call
`mcp__brain__librarian_apply_synthesis({plan_id, results: [{block_id, output}, ...], unresolved: [...]})`.
Any block in `unresolved` (or whose output fails the schema check) falls back to
deterministic-bullet append automatically — no harm done.

### Pointers

- Schema and conventions: `~/brain/SCHEMA.md`.
- Full architecture and roadmap: `~/projects/second-brain-design-2026-04-22/PLAN_v3.md`.
- Voice file (when drafting prose in Bjorn's voice): `~/brain/profile/voice.md` (bootstrapped after Tier 1.5).
<!-- BRAIN_BASELINE_END -->
