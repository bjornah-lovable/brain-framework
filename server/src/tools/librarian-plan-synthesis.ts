import { z } from "zod";
import { acquireLibrarianLock } from "../librarian/lock.js";
import {
  buildPendingPrompt,
  gatherSynthesizableTasks,
} from "../librarian/consolidate.js";

export const planSynthesisSchema = {
  wait_ms: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe(
      "How long to wait for the librarian lock if held. Default: 0 (fail fast).",
    ),
};

export interface PlanSynthesisResult {
  plan_id: string | null;
  applied_deterministically: {
    consolidated: number;
    routed_to_review: number;
    errors: number;
  };
  pending_synthesis: Array<{
    block_id: string;
    project_slug: string;
    section_id: string;
    section_kind: string;
    prompt: string;
    schema: object;
    capture_paths: string[];
  }>;
}

export function brainLibrarianPlanSynthesis(input: {
  wait_ms?: number;
}): PlanSynthesisResult {
  const opts = input.wait_ms !== undefined ? { waitMs: input.wait_ms } : {};
  const lock = acquireLibrarianLock(opts);
  try {
    const gathered = gatherSynthesizableTasks({ synthesize: true });
    const pending = gathered.pending.map((task) => {
      const { prompt, schema } = buildPendingPrompt(task);
      return {
        block_id: task.block_id,
        project_slug: task.project_slug,
        section_id: task.section_id,
        section_kind: task.section_kind,
        prompt,
        schema,
        capture_paths: task.capture_paths,
      };
    });
    return {
      plan_id: gathered.plan?.plan_id ?? null,
      applied_deterministically: {
        consolidated: gathered.applied_deterministically.consolidated,
        routed_to_review: gathered.applied_deterministically.routed_to_review,
        errors: gathered.applied_deterministically.errors,
      },
      pending_synthesis: pending,
    };
  } finally {
    lock.release();
  }
}
