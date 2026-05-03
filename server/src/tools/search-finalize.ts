import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { vaultPaths } from "../lib/vault.js";
import { looksLikeDossier } from "../lib/search/investigator.js";

export const searchFinalizeSchema = {
  search_id: z
    .string()
    .min(1)
    .describe(
      "search_id from a brain-search call that returned kind=pending_dispatch.",
    ),
  dossier: z
    .object({})
    .passthrough()
    .describe(
      "The SearchDossier produced by your Task subagent. Validated against the SearchDossier schema before persisting.",
    ),
};

export interface SearchFinalizeResult {
  ok: boolean;
  trace_path?: string;
  error?: { code: "NO_PLAN" | "SCHEMA_INVALID" | "STALE_PLAN"; message: string };
}

export function brainSearchFinalize(input: {
  search_id: string;
  dossier: Record<string, unknown>;
}): SearchFinalizeResult {
  const v = vaultPaths();
  if (!/^[A-Za-z0-9]+$/.test(input.search_id)) {
    return {
      ok: false,
      error: { code: "NO_PLAN", message: "invalid search_id format" },
    };
  }
  const tracePath = resolve(v.searchRuns, `${input.search_id}.json`);
  if (!existsSync(tracePath)) {
    return {
      ok: false,
      error: {
        code: "NO_PLAN",
        message: `no trace at ${tracePath} — call brain-search first`,
      },
    };
  }

  let trace: Record<string, unknown>;
  try {
    trace = JSON.parse(readFileSync(tracePath, "utf8")) as Record<string, unknown>;
  } catch {
    return {
      ok: false,
      error: { code: "NO_PLAN", message: "trace file unreadable" },
    };
  }

  const investigator = (trace["investigator"] as Record<string, unknown> | undefined) ?? {};
  const status = investigator["status"];
  if (status === "ok") {
    return {
      ok: false,
      error: {
        code: "STALE_PLAN",
        message: "trace is already finalized",
      },
    };
  }

  if (!looksLikeDossier(input.dossier)) {
    return {
      ok: false,
      error: {
        code: "SCHEMA_INVALID",
        message:
          "dossier failed shape check (sources/suggested_reads/open_questions arrays + confidence ∈ {high,medium,low})",
      },
    };
  }

  const finalizedAt = new Date().toISOString();
  trace["dossier"] = input.dossier;
  trace["investigator"] = {
    ...investigator,
    status: "ok",
    dispatched_by: "parent_task",
    completed_at: finalizedAt,
  };
  writeFileSync(tracePath, JSON.stringify(trace, null, 2), "utf8");

  return { ok: true, trace_path: tracePath };
}
