import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { vaultPaths } from "../lib/vault.js";
import { parseDoc } from "../lib/frontmatter.js";
import { acquireLibrarianLock } from "../librarian/lock.js";
import {
  computeSourceSha256,
  discoverProjects,
  existingBrainSlugs,
  normalizeStatus,
  prepareImport,
  readImportSources,
  resolveBrainSlugForImport,
  TRUNCATION_NOTE_REL_PATH,
  type ImportStatus,
} from "../librarian/import.js";
import {
  PROJECT_SECTIONS,
  projectBlockId,
  readBlockBody,
  readPageFrontmatter,
  writeImportedPointer,
  type SectionId,
  type SectionKind,
} from "../librarian/page.js";
import { indexPage, getBlockMetadata } from "../librarian/db-write.js";
import { savePlan, type PendingSynthesisTask } from "../librarian/plan-store.js";
import {
  buildFullPageImportPrompt,
  type CaptureToPromote,
  type FullPageImportInput,
  type SynthesisOutput,
} from "../librarian/synthesize.js";
import { loadConfig } from "../lib/config.js";

const STATUS_VALUES = ["active", "paused", "done", "abandoned"] as const;
const DEFAULT_STATUS_FILTER: ReadonlyArray<typeof STATUS_VALUES[number]> = ["active"];

export const planImportsSchema = {
  source: z
    .string()
    .optional()
    .describe(
      "Source directory containing <slug>-YYYY-MM-DD/ project folders. Default: ~/projects/.",
    ),
  status_filter: z
    .array(z.enum(STATUS_VALUES))
    .optional()
    .describe(
      "Only synthesize projects whose meta.yaml status matches. Default: ['active']. Pass ['active','paused','done'] to include all.",
    ),
  slugs: z
    .array(z.string())
    .optional()
    .describe(
      "Explicit brain-slug list (overrides status_filter).",
    ),
  force: z
    .boolean()
    .optional()
    .describe(
      "Re-synthesize even if the page's import_source_sha256 matches the current sources.",
    ),
  wait_ms: z.number().int().nonnegative().optional(),
};

/**
 * Public response shape. One entry per project, carrying:
 * - The four block_ids that need synthesis (one per page section).
 * - A single multi-block prompt and schema.
 * - The list of source file paths read for sha+telemetry.
 *
 * Apply protocol: parent dispatches one Task per pending_import,
 * receives a JSON object with four sub-objects (where_we_are,
 * blockers, recent_updates, artifacts) — one per block — splits into
 * four `apply-synthesis` result entries (one per block_id), and
 * calls `brain-librarian-apply-synthesis(plan_id, results)`.
 */
export interface PendingImport {
  project_slug: string;
  status: ImportStatus;
  blocks: Array<{
    block_id: string;
    section_id: SectionId;
    section_kind: SectionKind;
  }>;
  /**
   * Single full-page prompt (skill markdown + JSON payload). The
   * Task subagent returns one JSON object with four sub-objects
   * (one per block) per the schema.
   */
  prompt: string;
  schema: object;
  /** Relative paths of source files included for this project. */
  sources: string[];
  /** Total source bytes. Helps the parent reason about model+effort. */
  source_bytes: number;
}

export interface PlanImportsResult {
  plan_id: string | null;
  applied_deterministically: {
    pointer_pages_created: number;
    skipped: number;
  };
  /** Hint for the parent: imports benefit from Opus + thorough effort. */
  recommended_model: string;
  /** Walks the parent through the multi-block split protocol. */
  dispatch_guidance: string;
  pending_imports: PendingImport[];
}

/**
 * Phase-2 importer. Walks eligible projects, builds one full-page
 * synthesis task per project (replacing the older per-block fan-out),
 * persists the four backing PendingSynthesisTask entries to the plan
 * so apply-synthesis can write them block-by-block.
 */
export function brainLibrarianPlanImports(input: {
  source?: string;
  status_filter?: ReadonlyArray<typeof STATUS_VALUES[number]>;
  slugs?: string[];
  force?: boolean;
  wait_ms?: number;
}): PlanImportsResult {
  const v = vaultPaths();
  const opts = input.wait_ms !== undefined ? { waitMs: input.wait_ms } : {};
  const lock = acquireLibrarianLock(opts);
  try {
    const sourceDir = input.source ?? `${process.env.HOME}/projects`;
    const force = input.force === true;
    const statusFilter = new Set<string>(input.status_filter ?? DEFAULT_STATUS_FILTER);
    const slugFilter =
      input.slugs && input.slugs.length > 0
        ? new Set<string>(input.slugs)
        : null;

    const projects = discoverProjects(sourceDir);
    const knownSlugs = existingBrainSlugs(v.projects);

    let pointerPagesCreated = 0;
    let skipped = 0;
    const pendingTasksAll: PendingSynthesisTask[] = [];
    const pendingResponse: PendingImport[] = [];

    for (const project of projects) {
      const status = normalizeStatus(project.meta["status"]);
      if (!statusFilter.has(status) && !slugFilter) continue;

      const resolved = resolveBrainSlugForImport(
        project,
        knownSlugs,
        readPageFrontmatter,
      );
      const slug = resolved.slug;
      if (slugFilter && !slugFilter.has(slug)) continue;

      // Ensure pointer page exists. If it doesn't, create it now using
      // status-aware sources (so the sha is comparable on next run).
      const fm = readPageFrontmatter(slug);
      let currentSha: string | undefined =
        fm?.["import_source_sha256"] as string | undefined;
      if (!fm) {
        const { sha, frontmatter } = prepareImport(project, slug, { status });
        const w = writeImportedPointer(slug, frontmatter);
        if (w.created) {
          knownSlugs.add(slug);
          indexPage(w.path, "project");
          pointerPagesCreated++;
          currentSha = sha;
        }
      }

      // Status-aware source read. Reports + git log always; notes tiered.
      const sources = readImportSources(project.folderPath, { status });
      const newSha = computeSourceSha256(sources.normalised);
      if (!force && currentSha === newSha) {
        skipped++;
        continue;
      }

      // Backing plan-store tasks: one per block. Apply-synthesis still
      // takes per-block result entries; the parent splits the multi-
      // block Task response into four entries.
      const seedCaptures: CaptureToPromote[] = sources.files.map((f) => ({
        capture_path: `import:${tildify(f.absPath)}`,
        capture_kind: "import_seed",
        created_at: f.mtime,
        body: f.body,
      }));
      const blocksMeta: PendingImport["blocks"] = [];
      for (const section of PROJECT_SECTIONS) {
        const blockId = projectBlockId(slug, section.id);
        blocksMeta.push({
          block_id: blockId,
          section_id: section.id,
          section_kind: section.kind,
        });
        const task: PendingSynthesisTask = {
          block_id: blockId,
          project_slug: slug,
          section_id: section.id,
          section_kind: section.kind,
          capture_paths: seedCaptures.map((c) => c.capture_path),
          captures: seedCaptures.map((c, idx) => ({
            ...c,
            fname: `_import_${idx}`,
            src_abs: "/dev/null",
            session_id: "_import",
            trigger: "import",
          })),
          import_source_sha256: newSha,
        };
        pendingTasksAll.push(task);
      }

      // Build the single full-page prompt for the parent's Task call.
      const fullPageInput = buildFullPageInput(slug, status, sources);
      const { prompt, schema } = buildFullPageImportPrompt(fullPageInput);
      const sourceBytes = sources.files.reduce(
        (acc, f) => acc + f.body.length,
        0,
      );
      pendingResponse.push({
        project_slug: slug,
        status,
        blocks: blocksMeta,
        prompt,
        schema,
        sources: sources.files.map((f) => f.relPath),
        source_bytes: sourceBytes,
      });
    }

    const plan = pendingTasksAll.length > 0 ? savePlan(pendingTasksAll) : undefined;
    const cfg = loadConfig();

    return {
      plan_id: plan?.plan_id ?? null,
      applied_deterministically: {
        pointer_pages_created: pointerPagesCreated,
        skipped,
      },
      recommended_model: cfg.librarian.import_model,
      dispatch_guidance:
        "One-time legacy-project import. The schema produces three section blocks " +
        "in one response. For each `pending_imports` entry: (1) run a Task subagent " +
        "(`subagent_type: \"general-purpose\"`, `model: \"opus\"`) with the supplied " +
        "`prompt`; (2) parse the response — it has three sub-objects keyed " +
        "`blockers`, `recent_updates`, `artifacts`; (3) build three " +
        "result entries — `[{block_id: blocks[0].block_id, output: response.blockers}, " +
        "{block_id: blocks[1].block_id, output: response.recent_updates}, ...]`; (4) call " +
        "`brain-librarian-apply-synthesis({plan_id, results: [...]})` once per project " +
        "(or batch all projects' results into one apply call). Apply will stamp " +
        "`import_source_sha256` so subsequent plan-imports runs short-circuit. " +
        "Be thorough — bullets must be grounded in the supplied sources, but nothing " +
        "important should fall between cracks: reports, drafts, and git commit messages " +
        "all carry signal that working notes alone don't.",
      pending_imports: pendingResponse,
    };
  } finally {
    lock.release();
  }
}

function tildify(absPath: string): string {
  const home = process.env.HOME ?? "";
  if (home && absPath.startsWith(home + "/")) return "~" + absPath.slice(home.length);
  return absPath;
}

/**
 * Build the single full-page input the parent's Task subagent (or the
 * headless `runFullPageImportSynthesizer`) consumes. Pulls the four
 * current block bodies from the existing page (placeholder text on
 * first import) and any prior block-metadata for re-imports.
 */
function buildFullPageInput(
  slug: string,
  status: ImportStatus,
  sources: ReturnType<typeof readImportSources>,
): FullPageImportInput {
  const v = vaultPaths();
  const pagePath = resolve(v.projects, `${slug}.md`);
  const pageBody = existsSync(pagePath)
    ? parseDoc(readFileSync(pagePath, "utf8")).content
    : "";

  const blockIds = {
    blockers: projectBlockId(slug, "blockers"),
    recent_updates: projectBlockId(slug, "recent-updates"),
    artifacts: projectBlockId(slug, "artifacts"),
  };

  const currentBlockBodies = {
    blockers: readBlockBody(pageBody, blockIds.blockers) ?? "",
    recent_updates: readBlockBody(pageBody, blockIds.recent_updates) ?? "",
    artifacts: readBlockBody(pageBody, blockIds.artifacts) ?? "",
  };

  const previousMetadata: FullPageImportInput["previous_metadata"] = {};
  for (const [key, blockId] of Object.entries(blockIds) as Array<
    [keyof typeof blockIds, string]
  >) {
    const meta = getBlockMetadata(blockId);
    if (meta) {
      const out: SynthesisOutput = {
        new_block_body: "",
        summary: meta.summary,
        aliases: meta.aliases,
        entities: meta.entities,
        search_terms: meta.search_terms,
      };
      previousMetadata[key] = out;
    }
  }

  const sourcesPayload: FullPageImportInput["sources"] = sources.files.map(
    (f) => ({
      rel_path: f.relPath,
      kind:
        f.relPath === "_git-log"
          ? "git"
          : f.relPath === "meta.yaml" || f.relPath === TRUNCATION_NOTE_REL_PATH
            ? "meta"
            : f.relPath === "README.md" || f.relPath.startsWith("drafts/")
              ? "report"
              : "note",
      mtime: f.mtime,
      body: f.body,
    }),
  );

  const out: FullPageImportInput = {
    project_slug: slug,
    project_status: status,
    block_ids: blockIds,
    current_block_bodies: currentBlockBodies,
    sources: sourcesPayload,
  };
  if (Object.keys(previousMetadata).length > 0) {
    out.previous_metadata = previousMetadata;
  }
  return out;
}
