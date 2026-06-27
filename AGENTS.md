# brain — agent guide

> **STOP.** Before editing anything in this directory, read the four
> required docs below. Skipping this step has produced real bugs — see
> the commit history for `synthesize.plist` (created outside the
> install convention) and the cadence-mismatch follow-up.

## Required reading — every time, not just once

1. `~/brain/code/README.md` — repo layout, install conventions, build
   steps, safety invariants.
2. `~/brain/SCHEMA.md` — plane definitions, **cadence intent**,
   capture / page / sidecar formats, hard invariants.
3. `~/projects/second-brain-design-2026-04-22/PLAN_v3.md` — full
   architecture, **deltas table** at the top, roadmap. Especially the
   deltas table when changing anything with design history
   (synth path, dispatch model, importer, hooks). Each delta records
   *why* the current shape exists — don't undo a delta without
   understanding it.
4. The local `AGENTS.md` in any subdirectory you're editing.

## Install conventions — do not bypass

| concern | source of truth | install script |
|---|---|---|
| launchd plists | `scripts/<label>.plist` | `scripts/install-launchd.sh` |
| CC settings + sacred-paths hook | (in `scripts/install-settings.sh`) | `scripts/install-settings.sh` |
| baseline vault layout | (in `scripts/install-baseline.sh`) | `scripts/install-baseline.sh` |
| apiKeyHelper for headless `claude --bare` | `scripts/anthropic-key-helper.sh` | `scripts/setup-anthropic-key.sh` |

**Never write a plist directly into `~/Library/LaunchAgents/`.** Add /
edit the source under `scripts/` and re-run `install-launchd.sh`. Same
pattern for hooks, settings, baseline. Hand-edits to deployed copies
produce source/deployed drift that re-installation silently overwrites
and that other machines never see.

The MCP server's deployed entry point is `~/brain/code/server/dist/index.js`,
registered in `~/.claude.json` under `mcpServers.brain`. Moving it
requires updating `~/.claude.json`.

## Hard invariants — from `SCHEMA.md`

- Agents write **only** to `~/brain/captures/` (via `mcp__brain__brain-capture`).
  The librarian is the sole writer to `projects/`.
- A `PreToolUse` sacred-paths-guard hook blocks any
  `Write|Edit|MultiEdit|Bash` against `projects/`, `profile/`, `index.md`,
  `log.md`, `recent.md`; the MCP server enforces the same in code.
- `~/brain/raw/voice-samples*/` is append-only. Superseding voice samples
  go in as new files.
- `~/brain/.brain/db/` is a derived index — fully rebuildable from the
  filesystem.
- `~/brain/recent.md` is a derived view aggregated from project pages'
  `## Recent updates` blocks. Hand edits get overwritten on the next
  rebuild (`scripts/build-recent.py`, daily 18:15).

## Cadence intent — from `SCHEMA.md`

| plane | cadence | implication for schedule changes |
|---|---|---|
| `projects/` | **sub-daily, per project** | Pages must reflect captures within hours, not days. |
| `profile/` | Bjorn-edited only | Agent read-only. |
| `raw/voice-samples*/` | append-only | Add new samples; never edit existing ones. |
| `recent.md` (derived) | daily 18:15 | Rebuilt from project Recent updates blocks. |

If you propose changing the consolidate / synthesize / capture cadence,
check this table. "Every few days" is **not** sub-daily.

## Surfacing design changes

If your change touches design intent — cadence, plane semantics, write
boundaries, single-writer-librarian invariant, or any item in the
PLAN_v3 deltas table — say so explicitly to Bjorn before deviating. The
right shape:

> "I read [SCHEMA.md / PLAN_v3.md / …] and the doc says X. I propose
> Y because Z. Here's what changes; what would you prefer?"

Don't deviate silently and don't compress this away.

## Smoke test — run it before you commit

`scripts/smoke-test.sh` exercises ~27 end-to-end checks against an
isolated tempdir vault (does not touch `~/brain/`). It is the
verification harness; if it fails or you skipped it, the fix is
not done.

```bash
./scripts/smoke-test.sh
```

## Reviewers

If you're reviewing a change to this directory, the same rules apply:
read the four required docs, check that source-of-truth and deployed
artifacts haven't drifted, and run the smoke test before approving.
"It works on my machine after a hand-edit" is not approval-grade
evidence.
