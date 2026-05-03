#!/usr/bin/env bash
# Fake `claude` binary used by the synthesize smoke test. Reads the
# stdin prompt+payload, emits a hand-crafted dossier on stdout that
# satisfies the librarian-synthesis JSON schema, and exits 0.
#
# This lets us verify the entire synthesis pipeline (spawn, JSON parse,
# DB write, FTS5 indexing, sidecar provenance) without spending real
# tokens. Pointed at by CLAUDE_BIN in the smoke harness.

# Drain stdin so the parent's writer doesn't block on EPIPE.
cat >/dev/null

# Extract the project_slug and block_id from the env or use a default.
slug="${BRAIN_FAKE_SLUG:-second-brain}"
block_id="${BRAIN_FAKE_BLOCK_ID:-project.${slug}.recent-updates.v1}"

cat <<EOF
{
  "new_block_body": "## Recent updates\n<!-- brain:block ${block_id} -->\n\n- 2026-05-03 — Synthesizer round-trip verified: fake CLAUDE_BIN emits valid-schema dossier and the librarian writes the rewritten block plus per-block metadata into SQLite + FTS5.\n",
  "summary": "Verifies the Sonnet librarian wiring end-to-end without spending real tokens; uses a fake CLAUDE_BIN that returns a canned schema-conforming dossier.",
  "aliases": ["synthesize smoke", "fake CLAUDE_BIN", "librarian synthesis test"],
  "entities": ["brain-librarian", "blocks_metadata", "blocks_meta_fts", "Sonnet"],
  "search_terms": ["synthesize round-trip", "librarian llm path", "brain metadata indexed", "alias-based retrieval"],
  "no_op": false
}
EOF
