# brain — runtime code

Implementation of a personal agent-memory substrate: a markdown-first
vault as source of truth, a single-writer librarian, an MCP server as
the agent interface, sidecar provenance on stable block IDs, and a
silence-biased capture pipeline.

This repo is **Bjorn's personal framework**, published openly mostly so
the design is auditable from the outside. It is not a product, not
configurable enough for someone else's setup without changes, and has
no support model. If you want to fork it as a starting point, you
will need to read the architecture document linked below — the code
is opinionated and the conventions are load-bearing.

## What it does

The vault has three synthesised planes — `projects/` ("where are we
on X"), `feed/` (daily episodic), `knowledge/topics/` (durable
cross-project) — plus `profile/` (user-edited only), `raw/`
(append-only inputs), and `captures/` (agent staging). Agents talk
to the system through MCP tools (`brain-read`, `brain-search`,
`brain-capture`, `brain-ingest`, `brain-index`, `brain-status`, plus
parent-dispatch tools for librarian synthesis). They write only to
`captures/`; the librarian consolidates them into the synthesised
planes. A `PreToolUse` hook (`hooks/sacred-paths-guard.sh`, exit 2)
blocks direct writes to sacred paths as defence-in-depth.

## Architecture document

The full design (and roadmap to Tier 2/3) lives at:

```
~/projects/second-brain-design-2026-04-22/PLAN_v3.md
```

Not in this repo because it carries personal project history. The
load-bearing decisions in this code base track the deltas table at
the top of that document.

## Layout

```
server/src/         MCP server (TypeScript, stdio transport).
  tools/              brain-read, brain-search, brain-capture, …
  lib/                vault paths, frontmatter, secret scan, FTS5
                      candidate generation, search investigator.
  librarian/          consolidate, plan/apply synthesis, importer,
                      index regeneration, sidecar provenance.
  db/                 SQLite + FTS5 schema and read/write helpers.
  skills/             Markdown skill prompts + JSON schemas.
hooks/              Claude Code hook scripts.
capture/            Auto-capture pipeline (queue worker + scheduled
                    scan).
scripts/            launchd installer, settings installer, smoke test,
                    apiKeyHelper.
```

## Build

Requires Node 20+ and `pnpm`.

```bash
pnpm install
pnpm build
```

The build also rebuilds the `better-sqlite3` native binding for the
current Node version. If you upgrade Node, run `pnpm rebuild
better-sqlite3` (or delete `node_modules` and reinstall).

## Smoke test

`scripts/smoke-test.sh` exercises ~24 end-to-end checks — the MCP
tools, the parent-dispatch round-trip, the capture worker, the
import pipeline. It runs against an isolated tempdir vault by
default (cleaned up on exit), so it does not touch `~/brain/`. To
run against a specific existing vault, set `BRAIN_SMOKE_VAULT=<path>`.

```bash
./scripts/smoke-test.sh
```

## Register with Claude Code

```jsonc
// ~/.claude/settings.json
{
  "mcpServers": {
    "brain": {
      "command": "node",
      "args": ["/Users/bjornah/brain/code/server/dist/index.js"],
      "env": {
        "BRAIN_VAULT_ROOT": "/Users/bjornah/brain"
      }
    }
  }
}
```

`scripts/install-settings.sh` does this additively (preserves any
existing entries) and also installs the `PreToolUse` sacred-paths
guard.

## Safety invariants

- Agents never write to `projects/`, `feed/`, `knowledge/`, or
  `profile/`. They write only to `captures/` (via `brain-capture`).
  The librarian is the sole writer to synthesised planes.
- The `PreToolUse` sacred-paths guard exits 2 (blocking) on any
  `Write|Edit|MultiEdit|Bash` against sacred paths, with a Bash
  command-string heuristic that flags only write-shaped tokens
  (`>`, `>>`, `tee`, `mv`, `cp`, `rm`, `sed -i`, `chmod`, `chown`,
  `dd of=`).
- `brain-capture` runs a 15-pattern regex secret scan before writing.
  Hits route to `.brain/needs-review/` and the response surfaces only
  pattern names (never the matched text).
- `brain-ingest` rejects reserved roots (`~/.ssh`, `~/.aws`, `~/.gnupg`,
  `~/.config/{gcloud,gh}`, …), reserved filenames (`.env*`, `id_*`,
  `.pem`, `credentials*`, …), non-text extensions, files >5 MiB, and
  any path containing `..`.
- Subagent invocation (the headless fallback path): array argv (no
  shell), env `BRAIN_INTERNAL=1` propagated to prevent recursive
  capture. The default for interactive Claude Code sessions is
  parent-driven Task dispatch — the MCP tool returns a
  `pending_dispatch` payload and the parent agent runs the subagent
  via its own Task tool.

## License

MIT. See `LICENSE`. The choice is provisional and may change — see
the open question captured in the brain.
