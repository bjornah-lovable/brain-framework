#!/usr/bin/env node
/**
 * brain-server — MCP server (stdio) for the personal brain.
 *
 * Always-on tools (6):
 *   brain-read              read a page (mode=content) or sidecar (mode=provenance)
 *   brain-search            retrieval broker (FTS5 + Sonnet investigator)
 *   brain-search-finalize   return-path for brain-search pending_dispatch
 *   brain-capture           write a capture file (only write path)
 *   brain-index             return index.md
 *   brain-status            operational state + usage / cost summary
 *
 * Librarian-flow tools (3, gated by BRAIN_EXPOSE_LIBRARIAN_TOOLS=1):
 *   brain-librarian-plan-synthesis
 *   brain-librarian-plan-imports
 *   brain-librarian-apply-synthesis
 *
 * CLI-only (not MCP-registered):
 *   cost            (use `brain-librarian cost`)
 *   provenance      (folded into brain-read; use mode='provenance')
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { brainRead, readSchema } from "./tools/read.js";
import { brainSearch, searchSchema } from "./tools/search.js";
import { brainCapture, captureSchema } from "./tools/capture.js";
import { brainIndex, indexSchema } from "./tools/index-tool.js";
import { brainStatus, statusSchema } from "./tools/status.js";
import {
  brainSearchFinalize,
  searchFinalizeSchema,
} from "./tools/search-finalize.js";
import {
  brainLibrarianPlanSynthesis,
  planSynthesisSchema,
} from "./tools/librarian-plan-synthesis.js";
import {
  brainLibrarianApplySynthesis,
  applySynthesisSchema,
} from "./tools/librarian-apply-synthesis.js";
import {
  brainLibrarianPlanImports,
  planImportsSchema,
} from "./tools/librarian-plan-imports.js";

const server = new McpServer({
  name: "brain-server",
  version: "0.1.0",
});

server.tool(
  "brain-read",
  "Read a synthesized page from the brain. Default mode='content' returns page text (or one block, with `block`). mode='provenance' returns the sidecar JSON recording which captures fed which blocks. Path may be vault-relative ('projects/x.md') or absolute under ~/brain/.",
  readSchema,
  async (input) => {
    const result = brainRead(input);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  },
);

server.tool(
  "brain-search",
  "Search the brain. Returns a discriminated union: {kind:'dossier', dossier} for fast or zero-candidate queries (synchronous, $0); {kind:'pending_dispatch', search_id, prompt, schema, fallback_dossier, ...} for standard/deep when running in a parent CC session. On pending_dispatch: run a Task subagent (subagent_type='general-purpose') with the prompt; the subagent must return JSON matching schema; pass it to brain-search-finalize(search_id, dossier). The fallback_dossier is the deterministic-fast result if you decline to dispatch.",
  searchSchema,
  async (input) => {
    const result = await brainSearch(input);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  },
);

server.tool(
  "brain-capture",
  "Write a capture file. Only call when something worth keeping happened: a decision, a confirmed finding, a blocker, or a project state change. If nothing notable occurred, do not call.",
  captureSchema,
  async (input) => {
    const result = brainCapture(input);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  },
);

server.tool(
  "brain-index",
  "Return ~/brain/index.md — the librarian-maintained directory of synthesized pages.",
  indexSchema,
  async (input) => {
    const result = brainIndex(input);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  },
);

server.tool(
  "brain-status",
  "Operational state: tier, capture cadence, librarian lock, search runs recorded, enforcement flags. The `usage` block summarizes today / 7-day / 30-day brain LLM spend (capture worker + headless consolidate). Use the `brain-librarian cost` CLI for date-range breakdowns.",
  statusSchema,
  async (input) => {
    const result = brainStatus(input);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  },
);

server.tool(
  "brain-search-finalize",
  "Record a parent-dispatched SearchDossier for a search_id from a prior brain-search call that returned kind='pending_dispatch'. Validates dossier shape; updates the trace. Use only after running your Task subagent with the prompt+schema returned by brain-search.",
  searchFinalizeSchema,
  async (input) => {
    const result = brainSearchFinalize(
      input as { search_id: string; dossier: Record<string, unknown> },
    );
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  },
);

// Librarian-flow tools are gated. These are user-triggered plumbing
// for "consolidate" / "import legacy projects" workflows — agents
// don't pick them, the user runs them deliberately. Hide by default
// to keep the always-on tool list small. Set
// BRAIN_EXPOSE_LIBRARIAN_TOOLS=1 to register them.
if (process.env.BRAIN_EXPOSE_LIBRARIAN_TOOLS === "1") {
  server.tool(
    "brain-librarian-plan-synthesis",
    "Plan a synthesizing consolidate. Acquires the librarian lock, applies _unrouted captures deterministically, defers each project's affected block as a pending_synthesis task with prompt+schema ready to feed a Task subagent. Returns plan_id + per-block prompt+schema. Apply results via brain-librarian-apply-synthesis.",
    planSynthesisSchema,
    async (input) => {
      const result = brainLibrarianPlanSynthesis(input);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  );

  server.tool(
    "brain-librarian-plan-imports",
    "Plan a synthesis pass over existing ~/projects/<slug>-YYYY-MM-DD/ folders. Phase 1 (deterministic, $0): create pointer pages with frontmatter pulled from meta.yaml. Phase 2 (parent-dispatch): per active project, build per-block synthesis tasks whose 'captures' are README + notes/* + drafts/*. Returns plan_id + per-block prompt+schema. Apply via brain-librarian-apply-synthesis (same tool).",
    planImportsSchema,
    async (input) => {
      const result = brainLibrarianPlanImports(input);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  );

  server.tool(
    "brain-librarian-apply-synthesis",
    "Apply the parent's Task-subagent outputs to the plan. Replaces project-page blocks, indexes blocks_metadata + blocks_meta_fts, writes sidecar provenance, moves processed captures. Falls back to deterministic-bullet append for any block in `unresolved` or whose result fails the SynthesisOutput schema check.",
    applySynthesisSchema,
    async (input) => {
      const result = brainLibrarianApplySynthesis(
        input as {
          plan_id: string;
          results: Array<{ block_id: string; output: Record<string, unknown> }>;
          unresolved?: Array<{ block_id: string; reason: string }>;
          wait_ms?: number;
        },
      );
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  );
}

const transport = new StdioServerTransport();
await server.connect(transport);
