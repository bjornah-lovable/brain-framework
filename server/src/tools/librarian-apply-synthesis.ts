import { z } from "zod";
import { acquireLibrarianLock } from "../librarian/lock.js";
import { applySynthesisResults } from "../librarian/consolidate.js";
import { deletePlan, loadPlan } from "../librarian/plan-store.js";
import {
  looksLikeSynthesisOutput,
  type SynthesisOutput,
} from "../librarian/synthesize.js";

export const applySynthesisSchema = {
  plan_id: z
    .string()
    .min(1)
    .describe("plan_id from a prior brain-librarian-plan-synthesis call."),
  results: z
    .array(
      z.object({
        block_id: z.string(),
        output: z.object({}).passthrough(),
      }),
    )
    .describe(
      "Synthesizer outputs produced by your Task subagents, one per block_id from the plan. Validated against LibrarianSynthesis schema before persisting; failures route that block to the deterministic-append fallback.",
    ),
  unresolved: z
    .array(
      z.object({
        block_id: z.string(),
        reason: z.string(),
      }),
    )
    .optional()
    .describe(
      "Blocks the parent could not synthesize (timeout, abort, etc). These fall back to deterministic-bullet append.",
    ),
  wait_ms: z.number().int().nonnegative().optional(),
};

export interface ApplySynthesisResult {
  ok: boolean;
  consolidated?: number;
  fell_back_to_deterministic?: number;
  errors?: number;
  per_block?: Array<{
    block_id: string;
    method: "synthesized" | "appended_fallback";
    reason?: string;
    duration_ms?: number;
  }>;
  error?: { code: "NO_PLAN" | "STALE_PLAN"; message: string };
}

export function brainLibrarianApplySynthesis(input: {
  plan_id: string;
  results: Array<{ block_id: string; output: Record<string, unknown> }>;
  unresolved?: Array<{ block_id: string; reason: string }>;
  wait_ms?: number;
}): ApplySynthesisResult {
  const opts = input.wait_ms !== undefined ? { waitMs: input.wait_ms } : {};
  const lock = acquireLibrarianLock(opts);
  try {
    const plan = loadPlan(input.plan_id);
    if (!plan) {
      return {
        ok: false,
        error: {
          code: "NO_PLAN",
          message: `no plan at .brain/state/synthesis-plans/${input.plan_id}.json`,
        },
      };
    }

    // Validate each result; on shape mismatch, treat as unresolved.
    const validated: Array<{ block_id: string; output: SynthesisOutput }> = [];
    const unresolved: Array<{ block_id: string; reason: string }> = [
      ...(input.unresolved ?? []),
    ];
    for (const r of input.results) {
      if (looksLikeSynthesisOutput(r.output)) {
        validated.push({ block_id: r.block_id, output: r.output });
      } else {
        unresolved.push({
          block_id: r.block_id,
          reason: "schema_invalid",
        });
      }
    }

    const result = applySynthesisResults(plan.tasks, validated, unresolved);
    deletePlan(input.plan_id);

    return {
      ok: true,
      consolidated: result.consolidated,
      fell_back_to_deterministic: result.fell_back_to_deterministic,
      errors: result.errors,
      per_block: result.per_block.map((p) => ({
        block_id: p.block_id,
        method: p.method,
        ...(p.reason ? { reason: p.reason } : {}),
        ...(p.duration_ms !== undefined ? { duration_ms: p.duration_ms } : {}),
      })),
    };
  } finally {
    lock.release();
  }
}
