import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { ulid } from "ulid";
import { vaultPaths } from "../lib/vault.js";
import { loadConfig } from "../lib/config.js";
import { isInternal } from "../lib/session.js";
import { generateCandidates, type Candidate } from "../lib/search/candidates.js";
import {
  buildInvestigatorPrompt,
  runInvestigator,
  type InvestigatorDossier,
  investigatorPromptSha256,
} from "../lib/search/investigator.js";
import {
  buildWhereWeAreCandidates,
  projectLastTouchedMs,
  projectPageContentSha256,
  readWhereWeAreCache,
} from "../lib/search/where-we-are.js";
import { preferHeadlessForMcp } from "../librarian/consolidate.js";
import { appendOpLog } from "../lib/log.js";
import {
  CANDIDATE_GENERATOR_VERSION,
  VAULT_INDEX_VERSION,
  BRAIN_SERVER_VERSION,
} from "../lib/versions.js";

const SCOPE_VALUES = [
  "projects",
  "feed",
  "knowledge",
  "captures",
  "trajectories",
  "raw",
] as const;
const INTENT_VALUES = [
  "locate",
  "answer",
  "where_are_we",
  "timeline",
  "audit",
  "evidence",
  "prior_art",
] as const;
const FRESHNESS_VALUES = [
  "any",
  "recent",
  "last_24h",
  "last_7d",
  "last_30d",
] as const;

export const searchSchema = {
  query: z
    .string()
    .min(1)
    .describe("Natural-language query, e.g. 'where are we on stuck mitigation'."),
  intent: z
    .enum(INTENT_VALUES)
    .optional()
    .describe(
      "Optional explicit intent. Helps the broker route candidates and frame the answer.",
    ),
  scope: z
    .array(z.enum(SCOPE_VALUES))
    .optional()
    .describe(
      "Scope of search. Default: ['projects', 'feed', 'knowledge', 'captures'].",
    ),
  project_slug: z.string().optional(),
  freshness: z.enum(FRESHNESS_VALUES).optional().describe("Default 'any'."),
  depth: z
    .enum(["fast", "standard", "deep"])
    .optional()
    .describe(
      "fast: deterministic only ($0). standard/deep: pre-dispatch payload for parent Task subagent. Default: standard.",
    ),
  max_output_tokens: z.number().int().positive().optional(),
  max_sources: z.number().int().positive().optional(),
  require_provenance: z.boolean().optional(),
};

export interface SearchDossier {
  search_id: string;
  query: string;
  query_interpretation?: string;
  answer: string | null;
  confidence: "high" | "medium" | "low";
  depth: "fast" | "standard" | "deep";
  sources: InvestigatorDossier["sources"];
  suggested_reads: string[];
  open_questions: string[];
  diagnostics: {
    candidates_considered: number;
    investigator_status?: string;
    duration_ms: number;
    model?: string;
  };
}

export type BrainSearchResult =
  | { kind: "dossier"; dossier: SearchDossier }
  | {
      kind: "pending_dispatch";
      search_id: string;
      depth: "standard" | "deep";
      candidates: Candidate[];
      prompt: string;
      schema: object;
      fallback_dossier: SearchDossier;
      versions: {
        brain_server: string;
        vault_index: number;
        candidate_generator: number;
        investigator_prompt_sha256: string;
      };
      instructions: string;
    };

export async function brainSearch(input: {
  query: string;
  intent?: typeof INTENT_VALUES[number];
  scope?: ReadonlyArray<typeof SCOPE_VALUES[number]>;
  project_slug?: string;
  freshness?: typeof FRESHNESS_VALUES[number];
  depth?: "fast" | "standard" | "deep";
  max_output_tokens?: number;
  max_sources?: number;
  require_provenance?: boolean;
}): Promise<BrainSearchResult> {
  const cfg = loadConfig();
  const v = vaultPaths();
  const start = Date.now();
  const searchId = ulid();
  const depth = input.depth ?? cfg.search.default_depth;
  const maxSources = input.max_sources ?? cfg.search.default_max_sources;
  const scope =
    input.scope && input.scope.length > 0
      ? input.scope
      : (["projects", "feed", "knowledge", "captures"] as const);

  const maxCandidates = depth === "deep" ? maxSources * 4 : maxSources * 2;
  // intent=where_are_we with a project_slug switches to a dedicated
  // candidate set: the project page + recent processed captures. No
  // FTS5; the question is "what's the state of project X?", not a
  // free-text search. PLAN_v3 delta #15.
  const whereWeAreMode =
    input.intent === "where_are_we" &&
    typeof input.project_slug === "string" &&
    input.project_slug.length > 0;
  const candidates = whereWeAreMode
    ? buildWhereWeAreCandidates(input.project_slug!)
    : generateCandidates({
        query: input.query,
        scope,
        project_slug: input.project_slug,
        max_candidates: maxCandidates,
      });

  const queryFingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        q: input.query,
        scope,
        freshness: input.freshness,
        project: input.project_slug,
      }),
    )
    .digest("hex")
    .slice(0, 16);

  // Path 1 — fast / zero-candidate: synchronous deterministic dossier.
  if (depth === "fast" || candidates.length === 0) {
    const fast = fastDossierFromCandidates(candidates, maxSources, input.query);
    const finalDossier: SearchDossier = {
      search_id: searchId,
      query: input.query,
      query_interpretation: fast.query_interpretation,
      answer: fast.answer,
      confidence: fast.confidence,
      depth,
      sources: fast.sources,
      suggested_reads: fast.suggested_reads,
      open_questions: fast.open_questions,
      diagnostics: {
        candidates_considered: candidates.length,
        investigator_status: undefined,
        duration_ms: Date.now() - start,
        model: undefined,
      },
    };
    persistTrace({
      searchId,
      input,
      scope: scope as readonly string[],
      candidates,
      finalDossier,
      queryFingerprint,
      promptSha: investigatorPromptSha256(),
      investigator: { status: "fast_deterministic", flags: undefined, model: undefined },
    });
    return { kind: "dossier", dossier: finalDossier };
  }

  // Path 2 — explicit headless opt-in: spawn `claude --bare -p`. Only
  // taken when BRAIN_USE_HEADLESS_CLAUDE=1; just having
  // settings-bare.json present does NOT switch interactive search away
  // from parent-dispatch.
  if (preferHeadlessForMcp()) {
    const result = await runInvestigator({
      query: input.query,
      intent: input.intent,
      scope: scope as string[],
      project_slug: input.project_slug,
      freshness: input.freshness,
      max_sources: maxSources,
      candidates,
    });
    const finalDossier: SearchDossier = {
      search_id: searchId,
      query: input.query,
      query_interpretation: result.dossier.query_interpretation,
      answer: result.dossier.answer,
      confidence: result.dossier.confidence,
      depth,
      sources: result.dossier.sources,
      suggested_reads: result.dossier.suggested_reads,
      open_questions: result.dossier.open_questions,
      diagnostics: {
        candidates_considered: candidates.length,
        investigator_status: result.status,
        duration_ms: Date.now() - start,
        model: result.model,
      },
    };
    persistTrace({
      searchId,
      input,
      scope: scope as readonly string[],
      candidates,
      finalDossier,
      queryFingerprint,
      promptSha: result.prompt_sha256,
      investigator: {
        status: result.status,
        flags: result.flags,
        model: result.model,
      },
    });
    return { kind: "dossier", dossier: finalDossier };
  }

  // Path 3 — parent-driven dispatch (default for interactive CC).
  const { prompt, schema, promptSha } = buildInvestigatorPrompt({
    query: input.query,
    intent: input.intent,
    scope: scope as string[],
    project_slug: input.project_slug,
    freshness: input.freshness,
    max_sources: maxSources,
    candidates,
  });

  // Where-we-are cache lookup: keyed on (project_slug, page content
  // sha256, prompt sha). Cache hits return the prior dossier verbatim
  // with no LLM dispatch. Invalidates on any real content change to
  // the project page (inode-only mtime bumps from git checkout or
  // backups don't cause spurious misses) AND after a 7-day TTL.
  //
  // The dispatch-time snapshot of (mtime, content sha) is stored in
  // the search trace so finalize re-uses the same key it would have
  // matched on. If the project page is updated between dispatch and
  // finalize, the cache key is still the snapshot the LLM saw,
  // ensuring stale answers can't be cached against a newer page state.
  const dispatchMtimeMs = whereWeAreMode
    ? projectLastTouchedMs(input.project_slug!)
    : 0;
  const dispatchContentSha = whereWeAreMode
    ? projectPageContentSha256(input.project_slug!)
    : "";

  if (whereWeAreMode) {
    const cached = readWhereWeAreCache(
      input.project_slug!,
      dispatchContentSha,
      promptSha,
    );
    if (cached && typeof cached.dossier === "object" && cached.dossier !== null) {
      const cachedDossier = cached.dossier as Partial<SearchDossier>;
      const finalDossier: SearchDossier = {
        search_id: searchId,
        query: input.query,
        query_interpretation: cachedDossier.query_interpretation,
        answer: cachedDossier.answer ?? null,
        confidence: cachedDossier.confidence ?? "medium",
        depth,
        sources: cachedDossier.sources ?? [],
        suggested_reads: cachedDossier.suggested_reads ?? [],
        open_questions: cachedDossier.open_questions ?? [],
        diagnostics: {
          candidates_considered: candidates.length,
          investigator_status: "cache_hit",
          duration_ms: Date.now() - start,
          model: undefined,
        },
      };
      persistTrace({
        searchId,
        input,
        scope: scope as readonly string[],
        candidates,
        finalDossier,
        queryFingerprint,
        promptSha,
        investigator: {
          status: "cache_hit",
          flags: undefined,
          model: undefined,
          dispatch_mode: "where_we_are_cache",
        },
      });
      return { kind: "dossier", dossier: finalDossier };
    }
  }

  const fallback = fastDossierFromCandidates(candidates, maxSources, input.query);
  const fallbackDossier: SearchDossier = {
    search_id: searchId,
    query: input.query,
    query_interpretation: fallback.query_interpretation,
    answer: fallback.answer,
    confidence: fallback.confidence,
    depth,
    sources: fallback.sources,
    suggested_reads: fallback.suggested_reads,
    open_questions: fallback.open_questions,
    diagnostics: {
      candidates_considered: candidates.length,
      investigator_status: "pending_parent_dispatch",
      duration_ms: Date.now() - start,
      model: undefined,
    },
  };
  persistTrace({
    searchId,
    input,
    scope: scope as readonly string[],
    candidates,
    finalDossier: fallbackDossier,
    queryFingerprint,
    promptSha,
    investigator: {
      status: "pending_parent_dispatch",
      flags: undefined,
      model: undefined,
      dispatch_mode: "parent_task",
    },
    whereWeAreSnapshot: whereWeAreMode
      ? {
          project_slug: input.project_slug!,
          dispatch_page_mtime_ms: dispatchMtimeMs,
          dispatch_page_content_sha256: dispatchContentSha,
        }
      : undefined,
  });
  return {
    kind: "pending_dispatch",
    search_id: searchId,
    depth: depth === "deep" ? "deep" : "standard",
    candidates,
    prompt,
    schema,
    fallback_dossier: fallbackDossier,
    versions: {
      brain_server: BRAIN_SERVER_VERSION,
      vault_index: VAULT_INDEX_VERSION,
      candidate_generator: CANDIDATE_GENERATOR_VERSION,
      investigator_prompt_sha256: promptSha,
    },
    instructions:
      "Run a Task subagent (subagent_type='general-purpose') with the supplied `prompt`. " +
      "The subagent must return ONLY a JSON object matching `schema`. " +
      "Pass that JSON back via brain-search-finalize(search_id, dossier). " +
      "If the subagent fails or you decline to dispatch, the `fallback_dossier` is the deterministic-fast result you can use directly.",
  };
}

function persistTrace(args: {
  searchId: string;
  input: unknown;
  scope: readonly string[];
  candidates: Candidate[];
  finalDossier: SearchDossier;
  queryFingerprint: string;
  promptSha: string;
  investigator: {
    status: string;
    flags?: string[];
    model?: string;
    dispatch_mode?: string;
  };
  /** Snapshot of the project page state at dispatch time. Only set
   *  for where_are_we dispatches; lets finalize cache the dossier
   *  under the page state the LLM actually saw, even if the page is
   *  updated between dispatch and finalize. */
  whereWeAreSnapshot?: {
    project_slug: string;
    dispatch_page_mtime_ms: number;
    dispatch_page_content_sha256: string;
  };
}): void {
  const v = vaultPaths();
  try {
    mkdirSync(v.searchRuns, { recursive: true });
    const path = resolve(v.searchRuns, `${args.searchId}.json`);
    const trace: Record<string, unknown> = {
      search_id: args.searchId,
      query_fingerprint: args.queryFingerprint,
      input: args.input,
      internal: isInternal(),
      candidates: args.candidates,
      dossier: args.finalDossier,
      versions: {
        brain_server: BRAIN_SERVER_VERSION,
        vault_index: VAULT_INDEX_VERSION,
        candidate_generator: CANDIDATE_GENERATOR_VERSION,
        investigator_prompt_sha256: args.promptSha,
      },
      investigator: args.investigator,
    };
    if (args.whereWeAreSnapshot) {
      trace["where_we_are_snapshot"] = args.whereWeAreSnapshot;
    }
    writeFileSync(path, JSON.stringify(trace, null, 2), "utf8");
    appendOpLog(
      "search",
      `id=${args.searchId}  candidates=${args.candidates.length}  status=${args.investigator.status}  internal=${isInternal()}`,
    );
  } catch {
    // Diagnostic persistence is best-effort.
  }
}

function fastDossierFromCandidates(
  candidates: Candidate[],
  maxSources: number,
  query: string,
): InvestigatorDossier {
  const sources = candidates.slice(0, maxSources).map((c) => ({
    path: c.path,
    block_id: c.block_id,
    source_type: c.source_type,
    last_updated: c.last_updated,
    snippet: c.snippet.slice(0, 200),
    why_relevant: `match_reason=${c.match_reason}`,
    provenance_available: c.source_type === "synthesized_page",
  }));
  return {
    query_interpretation: `fast/deterministic search for "${query}"`,
    answer: null,
    confidence: "low",
    sources,
    suggested_reads: candidates
      .slice(0, 2)
      .map((c) =>
        c.block_id
          ? `brain-read ${c.path} --block ${c.block_id}`
          : `brain-read ${c.path}`,
      ),
    open_questions:
      candidates.length === 0
        ? ["No matches in deterministic candidates; consider depth=standard."]
        : [],
  };
}
