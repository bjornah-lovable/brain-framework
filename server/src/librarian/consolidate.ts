import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  appendFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { vaultPaths } from "../lib/vault.js";
import { parseDoc } from "../lib/frontmatter.js";
import { loadConfig } from "../lib/config.js";
import {
  ensureProjectPage,
  appendToProjectPage,
  projectPagePath,
  projectBlockId,
  readBlockBody,
  replaceBlockInPage,
  sectionForCaptureKind,
  sectionKindFor,
  setImportSourceSha,
  type SectionId,
} from "./page.js";
import { appendSidecar } from "./provenance.js";
import {
  indexCapture,
  indexPage,
  indexBlockMetadata,
  getBlockMetadata,
  markCaptureProcessed,
  recordProvenance,
} from "./db-write.js";
import {
  buildSynthesisPrompt,
  runFullPageImportSynthesizer,
  runSynthesizer,
  type CaptureToPromote,
  type FullPageImportInput,
  type SynthesisOutput,
  type SynthesizeInput,
} from "./synthesize.js";
import { normalizeStatus, readImportSources } from "./import.js";
import {
  savePlan,
  type PendingSynthesisTask,
  type PlanFile,
} from "./plan-store.js";
import { regenerateIndex } from "./index-page.js";

export interface ConsolidateOptions {
  /** Override config librarian.synthesize_with_llm; if true, attempt LLM synthesis per affected block. */
  synthesize?: boolean;
}

export interface ConsolidateResult {
  scanned: number;
  consolidated: number;
  routed_to_review: number;
  errors: number;
  synthesis: Array<{
    project_slug: string;
    block_id: string;
    method: "synthesized" | "appended_fallback";
    reason?: string;
    duration_ms?: number;
  }>;
}

interface ParsedCapture {
  src: string;
  fname: string;
  body: string;
  slug: string;
  sessionId: string;
  trigger: string;
  captureKind?: string;
  createdAt: string;
}

export interface GatherResult {
  scanned: number;
  applied_deterministically: {
    consolidated: number;
    routed_to_review: number;
    errors: number;
    synthesis: ConsolidateResult["synthesis"];
  };
  pending: PendingSynthesisTask[];
  /** Persisted plan file (only when pending is non-empty). */
  plan?: PlanFile;
}

export interface ApplyResult {
  consolidated: number;
  fell_back_to_deterministic: number;
  errors: number;
  per_block: ConsolidateResult["synthesis"];
}

/**
 * "Can we authenticate a headless `claude --bare -p` spawn right now?"
 * True if either an API-key env var is opted in, or settings-bare.json
 * (apiKeyHelper) is provisioned. Used by the **CLI** path
 * (`brain-librarian consolidate --synthesize`), which has no parent
 * CC agent and therefore must run headless.
 *
 * The MCP search tool uses `preferHeadlessForMcp()` instead — it
 * defaults to parent-dispatch even when headless is available, because
 * a parent CC session's Task tool is always cheaper than spawning a
 * separate `claude` process.
 */
export function headlessAvailable(): boolean {
  if (process.env.BRAIN_USE_HEADLESS_CLAUDE === "1") return true;
  const v = vaultPaths();
  return existsSync(resolve(v.dot, "settings-bare.json"));
}

/**
 * MCP-side preference: only an explicit env opt-in routes to
 * headless. Just having apiKeyHelper provisioned doesn't change the
 * dispatch shape returned by `brain-search`. This keeps the parent-
 * dispatch path as the cheap default for interactive CC use.
 */
export function preferHeadlessForMcp(): boolean {
  return process.env.BRAIN_USE_HEADLESS_CLAUDE === "1";
}

/**
 * First half of consolidation:
 *   1. Read every unprocessed capture.
 *   2. Park `_unrouted` ones in needs-review/ (always deterministic).
 *   3. Group the rest by (project_slug, section_id).
 *   4. If `synthesize: false` — apply every group deterministically
 *      (current behavior; "appended_fallback" method).
 *   5. If `synthesize: true` — defer every routable group as a
 *      pending synthesis task; persist a plan file.
 *
 * Holds whatever lock the caller acquired before invocation. Caller
 * is responsible for the librarian lock; this function is pure I/O
 * relative to the locked vault.
 */
export function gatherSynthesizableTasks(
  opts: { synthesize: boolean },
): GatherResult {
  const v = vaultPaths();
  mkdirSync(v.processed, { recursive: true });
  mkdirSync(v.needsReview, { recursive: true });
  mkdirSync(v.projects, { recursive: true });

  let entries: string[] = [];
  try {
    entries = readdirSync(v.captures).filter((f) => f.endsWith(".md"));
  } catch {
    return {
      scanned: 0,
      applied_deterministically: { consolidated: 0, routed_to_review: 0, errors: 0, synthesis: [] },
      pending: [],
    };
  }

  const parsed: ParsedCapture[] = [];
  let routedToReview = 0;
  let errors = 0;
  for (const fname of entries) {
    const src = resolve(v.captures, fname);
    let raw: string;
    try {
      raw = readFileSync(src, "utf8");
    } catch {
      errors++;
      continue;
    }
    const doc = parseDoc(raw);
    indexCapture(src);
    const slug = (doc.data["project_slug"] as string | undefined) ?? "_unrouted";
    if (slug === "_unrouted") {
      const dest = resolve(v.needsReview, fname);
      try {
        renameSync(src, dest);
        markCaptureProcessed(src, dest);
        routedToReview++;
      } catch {
        errors++;
      }
      continue;
    }
    parsed.push({
      src,
      fname,
      body: doc.content,
      slug,
      sessionId: (doc.data["session_id"] as string | undefined) ?? "_unknown",
      trigger: (doc.data["trigger"] as string | undefined) ?? "manual",
      captureKind: doc.data["capture_kind"] as string | undefined,
      createdAt:
        (doc.data["created_at"] as string | undefined) ??
        new Date().toISOString(),
    });
  }

  // Group by (slug, section_id).
  const groups = new Map<string, { slug: string; sectionId: SectionId; items: ParsedCapture[] }>();
  for (const p of parsed) {
    const sid = sectionForCaptureKind(p.captureKind);
    const key = `${p.slug}::${sid}`;
    if (!groups.has(key)) groups.set(key, { slug: p.slug, sectionId: sid, items: [] });
    groups.get(key)!.items.push(p);
  }

  const synthesisLog: ConsolidateResult["synthesis"] = [];
  const pending: PendingSynthesisTask[] = [];
  let consolidated = 0;

  for (const { slug, sectionId, items } of groups.values()) {
    ensureProjectPage(slug);
    const blockId = projectBlockId(slug, sectionId);

    if (opts.synthesize) {
      // Defer this group to the apply phase. Build the SynthesizeInput
      // upfront so the planner can hand prompt+schema to the parent.
      const path = projectPagePath(slug);
      const pageBody = parseDoc(readFileSync(path, "utf8")).content;
      const currentBlockBody = readBlockBody(pageBody, blockId) ?? "";
      const previousMetadata = getBlockMetadata(blockId) ?? undefined;
      const capturesToPromote: CaptureToPromote[] = items.map((it) => {
        const c: CaptureToPromote = {
          capture_path: `captures/${it.fname}`,
          created_at: it.createdAt,
          body: it.body,
        };
        if (it.captureKind) c.capture_kind = it.captureKind;
        return c;
      });
      void buildSynthesizeInput; // keep import in scope (prompt-builder uses these types)
      pending.push({
        block_id: blockId,
        project_slug: slug,
        section_id: sectionId,
        section_kind: sectionKindFor(sectionId),
        capture_paths: items.map((it) => `captures/${it.fname}`),
        captures: items.map((it) => {
          const c: PendingSynthesisTask["captures"][number] = {
            fname: it.fname,
            src_abs: it.src,
            session_id: it.sessionId,
            trigger: it.trigger,
            capture_path: `captures/${it.fname}`,
            created_at: it.createdAt,
            body: it.body,
          };
          if (it.captureKind) c.capture_kind = it.captureKind;
          return c;
        }),
      });
      // Note: previousMetadata + capturesToPromote + currentBlockBody
      // are reconstructed in the apply phase from the persisted task,
      // so we don't store them again here. Keeping local refs to
      // surface-side-effects via TS lint elimination.
      void previousMetadata;
      void capturesToPromote;
      void currentBlockBody;
      continue;
    }

    // Deterministic-only path: same code as v1 of consolidate, kept
    // bit-for-bit so the no-LLM smoke checks remain stable.
    try {
      const path = projectPagePath(slug);
      for (const it of items) {
        appendToProjectPage(slug, {
          body: it.body,
          capture_path: `captures/${it.fname}`,
          ...(it.captureKind ? { capture_kind: it.captureKind } : {}),
          created_at: it.createdAt,
        });
        indexPage(path, "project");
      }
      for (const it of items) {
        appendSidecar("projects", slug, blockId, {
          capture: `captures/${it.fname}`,
          session_id: it.sessionId,
          trigger: it.trigger,
          promoted_at: new Date().toISOString(),
        });
        recordProvenance(blockId, `captures/${it.fname}`, it.sessionId, it.trigger);
      }
      for (const it of items) {
        const dest = resolve(v.processed, it.fname);
        try {
          renameSync(it.src, dest);
          markCaptureProcessed(it.src, dest);
          consolidated++;
        } catch {
          errors++;
        }
      }
      synthesisLog.push({
        project_slug: slug,
        block_id: blockId,
        method: "appended_fallback",
        reason: "synthesize_disabled",
      });
    } catch (err) {
      errors += items.length;
      appendFileSync(
        resolve(v.logs, `librarian-${today()}.log`),
        `${new Date().toISOString()}  ERROR  group=${slug}/${sectionId}  ${(err as Error).message}\n`,
      );
    }
  }

  const result: GatherResult = {
    scanned: entries.length,
    applied_deterministically: {
      consolidated,
      routed_to_review: routedToReview,
      errors,
      synthesis: synthesisLog,
    },
    pending,
  };
  if (pending.length > 0) {
    result.plan = savePlan(pending);
  }
  return result;
}

/**
 * Second half of consolidation: turn parent-produced (or
 * runSynthesizer-produced) results into page rewrites + metadata
 * + sidecars + processed-captures, falling back deterministically
 * for any block the parent could not synthesize.
 */
export function applySynthesisResults(
  pending: PendingSynthesisTask[],
  results: Array<{ block_id: string; output: SynthesisOutput; prompt_sha256?: string; duration_ms?: number }>,
  unresolved: Array<{ block_id: string; reason: string }> = [],
): ApplyResult {
  const v = vaultPaths();
  const byBlockResult = new Map(results.map((r) => [r.block_id, r]));
  const unresolvedSet = new Set(unresolved.map((u) => u.block_id));
  const unresolvedReasons = new Map(unresolved.map((u) => [u.block_id, u.reason]));

  let consolidated = 0;
  let fellBack = 0;
  let errors = 0;
  const perBlock: ConsolidateResult["synthesis"] = [];

  for (const task of pending) {
    const path = projectPagePath(task.project_slug);
    const result = byBlockResult.get(task.block_id);
    let usedSynth = false;
    let reason: string | undefined;
    let durationMs: number | undefined;

    if (result && !unresolvedSet.has(task.block_id)) {
      const { replaced } = replaceBlockInPage(
        task.project_slug,
        task.section_id,
        result.output.new_block_body,
      );
      if (replaced) {
        indexPage(path, "project");
        indexBlockMetadata(
          path,
          task.block_id,
          {
            summary: result.output.summary,
            aliases: result.output.aliases,
            entities: result.output.entities,
            search_terms: result.output.search_terms,
          },
          result.prompt_sha256,
        );
        usedSynth = true;
        reason = "ok";
        durationMs = result.duration_ms;
      } else {
        reason = "block_marker_missing";
      }
    }

    const isImportTask = task.import_source_sha256 !== undefined;

    if (!usedSynth) {
      // Deterministic fallback: append per capture.
      try {
        for (const it of task.captures) {
          appendToProjectPage(task.project_slug, {
            body: it.body,
            capture_path: it.capture_path,
            ...(it.capture_kind ? { capture_kind: it.capture_kind } : {}),
            created_at: it.created_at,
          });
          indexPage(path, "project");
        }
        if (!reason) {
          reason =
            unresolvedReasons.get(task.block_id) ??
            "no_result_for_block";
        }
        fellBack++;
      } catch (err) {
        errors++;
        appendFileSync(
          resolve(v.logs, `librarian-${today()}.log`),
          `${new Date().toISOString()}  ERROR  block=${task.block_id}  ${(err as Error).message}\n`,
        );
      }
    }

    // Sidecar + DB provenance for every capture-shaped record.
    for (const it of task.captures) {
      appendSidecar("projects", task.project_slug, task.block_id, {
        capture: it.capture_path,
        session_id: it.session_id,
        trigger: it.trigger,
        promoted_at: new Date().toISOString(),
      });
      recordProvenance(task.block_id, it.capture_path, it.session_id, it.trigger);
    }

    if (isImportTask) {
      // Imports have no real captures to move; instead stamp the page
      // with the source sha for cache invalidation on next plan run.
      setImportSourceSha(task.project_slug, task.import_source_sha256!);
      consolidated++; // count the block as consolidated for parity with live tasks
    } else {
      for (const it of task.captures) {
        const dest = resolve(v.processed, it.fname);
        try {
          renameSync(it.src_abs, dest);
          markCaptureProcessed(it.src_abs, dest);
          consolidated++;
        } catch {
          errors++;
        }
      }
    }

    perBlock.push({
      project_slug: task.project_slug,
      block_id: task.block_id,
      method: usedSynth ? "synthesized" : "appended_fallback",
      ...(reason ? { reason } : {}),
      ...(durationMs !== undefined ? { duration_ms: durationMs } : {}),
    });
  }

  // Index regeneration is cheap — walks the synthesized planes via
  // frontmatter only — and any apply path can change a page's
  // last_touched / status. Regenerate unconditionally so callers that
  // never go through `consolidate()` (e.g. the parent-dispatch
  // apply-synthesis MCP tool) still keep index.md current.
  try {
    regenerateIndex();
  } catch {
    // Index regeneration failures shouldn't fail the apply step itself.
  }

  return { consolidated, fell_back_to_deterministic: fellBack, errors, per_block: perBlock };
}

/**
 * End-to-end consolidate. The deterministic path is the no-LLM
 * default. The synthesize path requires the headless `claude --bare`
 * pattern (apiKeyHelper-backed) — for parent-driven dispatch use
 * `brain-librarian-plan-synthesis` + `brain-librarian-apply-synthesis`
 * instead.
 */
export async function consolidate(
  opts: ConsolidateOptions = {},
): Promise<ConsolidateResult> {
  const v = vaultPaths();
  const cfg = loadConfig();
  const synthesize = opts.synthesize ?? cfg.librarian.synthesize_with_llm;

  if (synthesize && !headlessAvailable()) {
    throw new Error(
      "brain-librarian consolidate --synthesize requires headless availability " +
        "(BRAIN_USE_HEADLESS_CLAUDE=1 or ~/brain/.brain/settings-bare.json). " +
        "From a Claude Code session, use the brain-librarian-plan-synthesis MCP tool " +
        "and the parent-dispatch protocol instead.",
    );
  }

  const gathered = gatherSynthesizableTasks({ synthesize });

  let applyResult: ApplyResult = {
    consolidated: 0,
    fell_back_to_deterministic: 0,
    errors: 0,
    per_block: [],
  };

  if (synthesize && gathered.pending.length > 0) {
    const synthResults: Parameters<typeof applySynthesisResults>[1] = [];
    const unresolved: Array<{ block_id: string; reason: string }> = [];

    // Split: import tasks batch by project (one full-page Opus call per
    // project produces all four blocks); live tasks stay per-block.
    const importByProject = new Map<string, PendingSynthesisTask[]>();
    const liveTasks: PendingSynthesisTask[] = [];
    for (const task of gathered.pending) {
      if (task.import_source_sha256 !== undefined) {
        const arr = importByProject.get(task.project_slug) ?? [];
        arr.push(task);
        importByProject.set(task.project_slug, arr);
      } else {
        liveTasks.push(task);
      }
    }

    for (const [projectSlug, tasks] of importByProject) {
      const fullPageInput = reconstructFullPageImportInput(projectSlug, tasks);
      const r = await runFullPageImportSynthesizer(fullPageInput);
      if (r.ok && r.output) {
        const sectionToBlockId = new Map(
          tasks.map((t) => [t.section_kind, t.block_id]),
        );
        for (const sectionKey of [
          "where_we_are",
          "blockers",
          "recent_updates",
          "artifacts",
        ] as const) {
          const blockId = sectionToBlockId.get(sectionKey);
          if (!blockId) continue;
          synthResults.push({
            block_id: blockId,
            output: r.output[sectionKey],
            prompt_sha256: r.prompt_sha256,
            duration_ms: r.duration_ms,
          });
        }
      } else {
        // Whole-project failure → fall back deterministically per block.
        for (const t of tasks) {
          unresolved.push({
            block_id: t.block_id,
            reason: r.reason ?? "unknown_failure",
          });
        }
      }
    }

    for (const task of liveTasks) {
      const synthInput = reconstructSynthesizeInput(task);
      const r = await runSynthesizer(synthInput, "live");
      if (r.ok && r.output) {
        synthResults.push({
          block_id: task.block_id,
          output: r.output,
          prompt_sha256: r.prompt_sha256,
          duration_ms: r.duration_ms,
        });
      } else {
        unresolved.push({
          block_id: task.block_id,
          reason: r.reason ?? "unknown_failure",
        });
      }
    }
    applyResult = applySynthesisResults(gathered.pending, synthResults, unresolved);
  }

  const summary = `${new Date().toISOString()}  consolidate  scanned=${gathered.scanned}  consolidated=${gathered.applied_deterministically.consolidated + applyResult.consolidated}  routed_to_review=${gathered.applied_deterministically.routed_to_review}  errors=${gathered.applied_deterministically.errors + applyResult.errors}  synthesize=${synthesize}\n`;
  appendFileSync(v.log, summary);
  appendFileSync(resolve(v.logs, `librarian-${today()}.log`), summary);

  // Regenerate index.md after every consolidate. The deterministic
  // path (synthesize=false) writes pages without going through
  // applySynthesisResults, so the index regen there wouldn't fire.
  try {
    regenerateIndex();
  } catch {
    // Non-fatal.
  }

  return {
    scanned: gathered.scanned,
    consolidated:
      gathered.applied_deterministically.consolidated + applyResult.consolidated,
    routed_to_review: gathered.applied_deterministically.routed_to_review,
    errors: gathered.applied_deterministically.errors + applyResult.errors,
    synthesis: [
      ...gathered.applied_deterministically.synthesis,
      ...applyResult.per_block,
    ],
  };
}

/**
 * Reconstruct the full-page input for one project from its four
 * persisted PendingSynthesisTask entries. Re-reads the project folder
 * status-aware so we get the same source set the planner did.
 */
function reconstructFullPageImportInput(
  projectSlug: string,
  tasks: PendingSynthesisTask[],
): FullPageImportInput {
  const v = vaultPaths();
  const pagePath = projectPagePath(projectSlug);
  const pageBody = parseDoc(readFileSync(pagePath, "utf8")).content;
  const fm = parseDoc(readFileSync(pagePath, "utf8")).data;
  const dataPathRaw =
    (fm["data_path"] as string | undefined) ?? "";
  const folderPath = expandHomePath(dataPathRaw);
  const status = normalizeStatus(fm["status"]);

  const blockByKind = new Map(
    tasks.map((t) => [t.section_kind, t.block_id]),
  );
  const blockIds = {
    where_we_are: blockByKind.get("where_we_are") ?? projectBlockId(projectSlug, "where-we-are"),
    blockers: blockByKind.get("blockers") ?? projectBlockId(projectSlug, "blockers"),
    recent_updates: blockByKind.get("recent_updates") ?? projectBlockId(projectSlug, "recent-updates"),
    artifacts: blockByKind.get("artifacts") ?? projectBlockId(projectSlug, "artifacts"),
  };

  const currentBlockBodies = {
    where_we_are: readBlockBody(pageBody, blockIds.where_we_are) ?? "",
    blockers: readBlockBody(pageBody, blockIds.blockers) ?? "",
    recent_updates: readBlockBody(pageBody, blockIds.recent_updates) ?? "",
    artifacts: readBlockBody(pageBody, blockIds.artifacts) ?? "",
  };

  const sources = readImportSources(folderPath, { status });
  const sourcesPayload: FullPageImportInput["sources"] = sources.files.map(
    (f) => ({
      rel_path: f.relPath,
      kind:
        f.relPath === "_git-log"
          ? "git"
          : f.relPath === "meta.yaml"
            ? "meta"
            : f.relPath === "README.md" || f.relPath.startsWith("drafts/")
              ? "report"
              : "note",
      mtime: f.mtime,
      body: f.body,
    }),
  );

  void v;
  return {
    project_slug: projectSlug,
    project_status: status,
    block_ids: blockIds,
    current_block_bodies: currentBlockBodies,
    sources: sourcesPayload,
  };
}

function expandHomePath(p: string): string {
  if (p === "~") return process.env.HOME ?? p;
  if (p.startsWith("~/")) return (process.env.HOME ?? "") + p.slice(1);
  return p;
}

/**
 * Rebuild the SynthesizeInput from a persisted PendingSynthesisTask.
 * Used by both the headless consolidate path and any future caller
 * that wants to drive the synthesizer over a stored plan.
 */
export function reconstructSynthesizeInput(
  task: PendingSynthesisTask,
): SynthesizeInput {
  const path = projectPagePath(task.project_slug);
  const pageBody = parseDoc(readFileSync(path, "utf8")).content;
  const currentBlockBody = readBlockBody(pageBody, task.block_id) ?? "";
  const previousMetadata = getBlockMetadata(task.block_id) ?? undefined;
  const capturesToPromote: CaptureToPromote[] = task.captures.map((it) => {
    const c: CaptureToPromote = {
      capture_path: it.capture_path,
      created_at: it.created_at,
      body: it.body,
    };
    if (it.capture_kind) c.capture_kind = it.capture_kind;
    return c;
  });
  const synthInput: SynthesizeInput = {
    project_slug: task.project_slug,
    block_id: task.block_id,
    section_kind: task.section_kind,
    current_block_body: currentBlockBody,
    captures_to_promote: capturesToPromote,
  };
  if (previousMetadata) synthInput.previous_metadata = previousMetadata;
  return synthInput;
}

/**
 * Build the prompt + schema + sha for a pending task — used by the
 * MCP planner to hand to a parent agent's Task subagent.
 */
export function buildPendingPrompt(task: PendingSynthesisTask): {
  prompt: string;
  schema: object;
  promptSha: string;
} {
  return buildSynthesisPrompt(reconstructSynthesizeInput(task));
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

// `buildSynthesizeInput` is referenced for type wiring above.
const buildSynthesizeInput = reconstructSynthesizeInput;
