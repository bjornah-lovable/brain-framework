import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { assertSourceProjectsAllowed } from "../lib/safety.js";
import { loadConfig } from "../lib/config.js";

/**
 * Synthetic source rel_path for the truncation note appended when the
 * input cap kicks in. Both consumers special-case this in their
 * `kind:` switch so the model sees it as `meta`.
 */
export const TRUNCATION_NOTE_REL_PATH = "_truncation-note";

export interface DiscoveredProject {
  /** Folder name on disk: `<slug>-YYYY-MM-DD` or legacy bare slug. */
  folderName: string;
  /** Absolute path to the project folder (validated under the source root). */
  folderPath: string;
  /** Parsed meta.yaml content. */
  meta: Record<string, unknown>;
}

export interface ImportSources {
  /** Absolute path → file content. Order: README first, then notes by mtime, then drafts by mtime. */
  files: Array<{
    relPath: string;
    absPath: string;
    body: string;
    mtime: string; // ISO
  }>;
  /** Concatenated normalised content used for sha256. */
  normalised: string;
}

const STATUS_MAP: Record<string, string> = {
  complete: "done",
  done: "done",
  active: "active",
  paused: "paused",
  abandoned: "abandoned",
};

export type ImportStatus = "active" | "paused" | "done" | "abandoned";

/**
 * Source-tier policy by project status. Reports (README + meta +
 * drafts/*) are always included. Notes get tiered down by status —
 * completed and abandoned projects already condensed their conclusions
 * into drafts/, so reading every working note adds bulk without much
 * new signal. Git log is decision-laden and small; included for any
 * status except abandoned.
 *
 * `notesLimit`: max notes to include, sorted by mtime descending
 *   (most recent kept). `Infinity` = include all.
 * `gitLogLimit`: max commits to include via `git log --max-count=N`.
 *   0 = skip git log entirely.
 */
const SOURCE_TIERS: Record<ImportStatus, { notesLimit: number; gitLogLimit: number }> = {
  active: { notesLimit: Number.POSITIVE_INFINITY, gitLogLimit: 100 },
  paused: { notesLimit: 10, gitLogLimit: 50 },
  done: { notesLimit: 3, gitLogLimit: 30 },
  abandoned: { notesLimit: 0, gitLogLimit: 0 },
};

export function normalizeStatus(raw: unknown): ImportStatus {
  if (typeof raw !== "string") return "active";
  const mapped = STATUS_MAP[raw.toLowerCase()];
  if (mapped === "active" || mapped === "paused" || mapped === "done" || mapped === "abandoned") {
    return mapped;
  }
  return "active"; // unknown statuses get the most-thorough policy
}

/**
 * Walk the source directory, returning a list of `(folder, meta)`
 * pairs. Skips `_template` (CHANGEME placeholders), files-not-dirs,
 * and folders without a meta.yaml.
 */
export function discoverProjects(sourceDir: string): DiscoveredProject[] {
  const root = assertSourceProjectsAllowed(sourceDir, sourceDir);
  const out: DiscoveredProject[] = [];
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name === "_template" || name.startsWith(".")) continue;
    const folderPath = resolve(root, name);
    let st;
    try {
      st = statSync(folderPath);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    const metaPath = resolve(folderPath, "meta.yaml");
    if (!existsSync(metaPath)) continue;
    let meta: Record<string, unknown>;
    try {
      const raw = readFileSync(metaPath, "utf8");
      meta = (parseYaml(raw) ?? {}) as Record<string, unknown>;
    } catch {
      continue;
    }
    out.push({ folderName: name, folderPath, meta });
  }
  return out;
}

/**
 * Date-strip a folder name to derive the brain slug. Matches the
 * trailing `-YYYY-MM-DD` and removes it. Folders without a date
 * suffix (legacy `understand_monorepo`-style) pass through.
 *
 * On collision (slug already used by a different folder), append the
 * date back: `stuck-investigation` + `2026-04-07` → `stuck-investigation-2026-04-07`.
 */
export function brainSlugFor(
  folderName: string,
  knownSlugs: ReadonlySet<string>,
): { slug: string; collided: boolean } {
  const m = /^(.+?)-(\d{4}-\d{2}-\d{2})$/.exec(folderName);
  const base = m ? m[1]! : folderName;
  const date = m ? m[2]! : null;
  if (!knownSlugs.has(base)) {
    return { slug: base, collided: false };
  }
  if (date) {
    const dated = `${base}-${date}`;
    return { slug: dated, collided: true };
  }
  // Bare name collision with no date — fall back to the folder name.
  return { slug: folderName, collided: true };
}

/**
 * Read sources from a project folder, status-aware. README + meta +
 * drafts/* are always included. Notes are tiered by status (most-recent
 * kept). Git log is included as a synthetic source when the folder is
 * tracked. The concatenated, deterministic-ordered output drives the
 * synthesizer prompt and the import_source_sha256 cache key.
 */
export function readImportSources(
  folderPath: string,
  options: {
    status?: ImportStatus;
    includeGitLog?: boolean;
    /**
     * Maximum bytes (UTF-8) summed over all source bodies. Defaults to
     * `librarian.import_max_input_bytes` from .brain/config.yaml. Pass
     * 0 to disable. When exceeded, oldest non-anchor sources are
     * dropped first; a synthetic `_truncation-note` source is prepended
     * so the model is told what was truncated.
     */
    maxInputBytes?: number;
  } = {},
): ImportSources {
  const status = options.status ?? "active";
  const tier = SOURCE_TIERS[status];
  const includeGitLog = options.includeGitLog !== false;
  const maxInputBytes =
    options.maxInputBytes ?? loadConfig().librarian.import_max_input_bytes;

  const files: ImportSources["files"] = [];

  const readMaybe = (relPath: string) => {
    const abs = resolve(folderPath, relPath);
    if (!existsSync(abs)) return;
    let body: string;
    let mtime: string;
    try {
      body = readFileSync(abs, "utf8");
      mtime = statSync(abs).mtime.toISOString();
    } catch {
      return;
    }
    files.push({ relPath, absPath: abs, body, mtime });
  };

  // T1: always-included reports.
  readMaybe("README.md");
  readMaybe("meta.yaml");

  // drafts/* — always all of them. Reports condense conclusions; cap-free.
  appendDirSorted(folderPath, "drafts", Number.POSITIVE_INFINITY, files, readMaybe);

  // T2: notes/*, status-tiered.
  if (tier.notesLimit > 0) {
    appendDirSorted(folderPath, "notes", tier.notesLimit, files, readMaybe);
  }

  // Synthetic git-log source. Decision-laden, low-token, high-signal —
  // worth fetching even for done/paused projects. abandoned skip via
  // gitLogLimit = 0.
  if (includeGitLog && tier.gitLogLimit > 0) {
    const log = collectGitLog(folderPath, tier.gitLogLimit);
    if (log) {
      files.push({
        relPath: "_git-log",
        absPath: `${folderPath}::git-log`,
        body: log,
        mtime: new Date().toISOString(),
      });
    }
  }

  // Apply the input cap (oldest-first drops, README+meta preserved).
  // The cap shapes both the LLM payload and the sha — same content
  // truncated under different caps gets different shas, which forces
  // a fresh synthesis run when the cap changes.
  const capped = applyInputCap(files, maxInputBytes);

  // Normalise: trim trailing whitespace per file; concatenate with
  // a stable separator including the relPath so renames change sha.
  const parts = capped.map((f) => `\n--- ${f.relPath} ---\n${f.body.replace(/\s+$/g, "")}\n`);
  return { files: capped, normalised: parts.join("") };
}

/**
 * Drop oldest non-anchor sources until the total UTF-8 byte size is at
 * or under `maxBytes`. README.md and meta.yaml are anchors and are
 * preserved as long as possible; notes/ go first (oldest mtime first),
 * then drafts/, then synthetic _git-log. On any drop we prepend a
 * synthetic `_truncation-note` source so the synthesizer is explicitly
 * told what's missing and works from the most-recent material remaining.
 *
 * `maxBytes <= 0` disables the cap and returns inputs unchanged.
 */
export function applyInputCap(
  files: ImportSources["files"],
  maxBytes: number,
): ImportSources["files"] {
  if (maxBytes <= 0) return files;

  const byteLen = (s: string) => Buffer.byteLength(s, "utf8");
  let totalBytes = files.reduce((sum, f) => sum + byteLen(f.body), 0);
  if (totalBytes <= maxBytes) return files;

  const isAnchor = (rel: string) => rel === "README.md" || rel === "meta.yaml";

  // Build the ordered drop queue: synthetic git-log first (least
  // signal-dense for a fixed byte cost), then notes oldest-first, then
  // drafts oldest-first. Anchors are never queued.
  const droppable = files
    .filter((f) => !isAnchor(f.relPath))
    .map((f) => ({ ...f }));
  droppable.sort((a, b) => {
    const tier = (rel: string) =>
      rel === "_git-log" ? 0 : rel.startsWith("notes/") ? 1 : rel.startsWith("drafts/") ? 2 : 3;
    const tA = tier(a.relPath);
    const tB = tier(b.relPath);
    if (tA !== tB) return tA - tB;
    return a.mtime.localeCompare(b.mtime); // older first
  });

  const drop = new Set<string>();
  let droppedBytes = 0;
  let droppedCount = 0;
  for (const f of droppable) {
    if (totalBytes <= maxBytes) break;
    const b = byteLen(f.body);
    drop.add(f.relPath);
    totalBytes -= b;
    droppedBytes += b;
    droppedCount += 1;
  }

  const kept = files.filter((f) => !drop.has(f.relPath));

  if (droppedCount === 0) return kept;

  const noteBody =
    `[INPUT TRUNCATED]\n` +
    `Project source content exceeded the import cap of ${maxBytes} bytes. ` +
    `Dropped ${droppedCount} oldest source files (${droppedBytes} bytes total). ` +
    `Synthesise the four blocks from the most-recent material remaining; ` +
    `older context is intentionally not visible to this call.`;

  const note: ImportSources["files"][number] = {
    relPath: TRUNCATION_NOTE_REL_PATH,
    absPath: `<truncation-note>`,
    body: noteBody,
    mtime: new Date().toISOString(),
  };
  return [note, ...kept];
}

function appendDirSorted(
  folderPath: string,
  sub: string,
  limit: number,
  files: ImportSources["files"],
  readMaybe: (relPath: string) => void,
): void {
  const dir = resolve(folderPath, sub);
  if (!existsSync(dir)) return;
  let entries: string[];
  try {
    entries = readdirSync(dir).filter((f) => f.endsWith(".md"));
  } catch {
    return;
  }
  const withStat = entries.map((f) => {
    const abs = resolve(dir, f);
    const st = statSync(abs);
    return { f, abs, mtime: st.mtime };
  });
  // For limited tiers we want the MOST RECENT N, but we still want the
  // synthesizer to see them in chronological order. Sort desc to slice,
  // then re-sort asc.
  withStat.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  const kept = withStat.slice(0, limit);
  kept.sort((a, b) => a.mtime.getTime() - b.mtime.getTime());
  for (const { f } of kept) {
    readMaybe(`${sub}/${f}`);
    void files; // shape kept for symmetry
  }
}

/**
 * Run `git log` against the project folder. Works whether the folder
 * is its own git repo or a subdirectory of a parent one. Returns an
 * empty string if not tracked or git is unavailable.
 *
 * Format: short hash, ISO date, subject, indented body, separator.
 */
function collectGitLog(folderPath: string, maxCount: number): string {
  // Sanity check: any git repo we can reach from the folder?
  const isInside = spawnSync(
    "git",
    ["-C", folderPath, "rev-parse", "--is-inside-work-tree"],
    { encoding: "utf8" },
  );
  if (isInside.status !== 0 || isInside.stdout.trim() !== "true") {
    return "";
  }

  const fmt =
    "%h | %aI | %s%n%b%n--end--";
  const result = spawnSync(
    "git",
    [
      "-C",
      folderPath,
      "log",
      `--max-count=${maxCount}`,
      `--pretty=format:${fmt}`,
      "--no-decorate",
      "--",
      ".",
    ],
    { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
  );
  if (result.status !== 0) return "";
  return result.stdout.trim();
}

export function computeSourceSha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Translate meta.yaml frontmatter into brain page frontmatter, per
 * PLAN_v3_import_existing_projects.md §4.
 */
export function frontmatterFromMeta(
  meta: Record<string, unknown>,
  folderPath: string,
  brainSlug: string,
  importSourceSha256?: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    slug: brainSlug,
    data_path: shortenHomePath(folderPath) + "/",
    last_touched: getFolderMtime(folderPath),
    imported_at: new Date().toISOString(),
  };
  if (importSourceSha256) {
    // Phase 1 (import-pointers) leaves this unset; Phase 2's apply
    // stamps it after a successful synthesis. That way the pointer
    // page is discoverable immediately but plan-imports doesn't
    // short-circuit before the first synthesis runs.
    out["import_source_sha256"] = importSourceSha256;
  }

  if (meta["created"] !== undefined) out["created"] = meta["created"];
  if (meta["status"] !== undefined) {
    const raw = String(meta["status"]).toLowerCase();
    out["status"] = STATUS_MAP[raw] ?? raw;
  }
  if (meta["owner"] !== undefined) out["owner"] = meta["owner"];
  if (meta["prefix"] !== undefined) out["todo_prefix"] = meta["prefix"];
  if (meta["linear"] !== undefined) {
    out["linear"] = (meta["linear"] as unknown[]).map(stripInlineComment);
  }
  if (meta["prs"] !== undefined) out["prs"] = meta["prs"];
  if (meta["notion"] !== undefined) out["notion"] = meta["notion"];
  if (meta["slack_threads"] !== undefined) {
    out["slack_threads"] = meta["slack_threads"];
  }
  if (meta["depends_on"] !== undefined) out["depends_on"] = meta["depends_on"];
  if (meta["tags"] !== undefined) out["tags"] = meta["tags"];

  return out;
}

function stripInlineComment(v: unknown): unknown {
  if (typeof v !== "string") return v;
  const idx = v.indexOf(" #");
  if (idx === -1) return v.trim();
  return v.slice(0, idx).trim();
}

function shortenHomePath(p: string): string {
  const home = homedir();
  if (p === home) return "~";
  if (p.startsWith(home + "/")) return "~" + p.slice(home.length);
  return p;
}

function getFolderMtime(folderPath: string): string {
  try {
    return statSync(folderPath).mtime.toISOString();
  } catch {
    return new Date().toISOString();
  }
}

/**
 * Convenience accessor: given a project folder path, return
 * `{sources, sha, frontmatter}` ready to feed into both the pointer
 * writer and the synthesis planner.
 *
 * Pass `stampSha: true` to embed the source sha in the frontmatter
 * (Phase 2 apply does this after a successful synthesis). Phase 1
 * (import-pointers) leaves it unstamped so plan-imports can run
 * synthesis at least once before short-circuiting.
 */
export function prepareImport(
  project: DiscoveredProject,
  brainSlug: string,
  opts: { stampSha?: boolean; status?: ImportStatus; includeGitLog?: boolean } = {},
): {
  sources: ImportSources;
  sha: string;
  frontmatter: Record<string, unknown>;
} {
  const status = opts.status ?? normalizeStatus(project.meta["status"]);
  const sourcesOpts: { status: ImportStatus; includeGitLog?: boolean } = { status };
  if (opts.includeGitLog !== undefined) {
    sourcesOpts.includeGitLog = opts.includeGitLog;
  }
  const sources = readImportSources(project.folderPath, sourcesOpts);
  const sha = computeSourceSha256(sources.normalised);
  const frontmatter = frontmatterFromMeta(
    project.meta,
    project.folderPath,
    brainSlug,
    opts.stampSha ? sha : undefined,
  );
  return { sources, sha, frontmatter };
}

/**
 * Best-effort metadata-folder name → brain slug round trip used by
 * the importer to detect "this folder maps to an existing brain page".
 */
export function existingBrainSlugs(brainProjectsDir: string): Set<string> {
  const out = new Set<string>();
  let entries: string[];
  try {
    entries = readdirSync(brainProjectsDir);
  } catch {
    return out;
  }
  for (const f of entries) {
    if (f.endsWith(".md")) out.add(basename(f, ".md"));
  }
  return out;
}

export function expandHomePath(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return homedir() + path.slice(1);
  return path;
}

/**
 * Resolve the brain slug for an existing project folder, in a way
 * that's idempotent across re-runs:
 *
 *   1. Compute the date-stripped base slug.
 *   2. If `<base>.md` already exists AND its `data_path` points back
 *      at this folder → return the base slug as "already-claims".
 *   3. Else if `<base>.md` exists but claims a different folder →
 *      collision, fall back to `<base>-<date>.md`.
 *   4. Else return the base slug.
 *
 * `pageFrontmatterReader` is injected to avoid a circular import.
 */
export function resolveBrainSlugForImport(
  project: DiscoveredProject,
  knownSlugs: ReadonlySet<string>,
  pageFrontmatterReader: (slug: string) => Record<string, unknown> | null,
): {
  slug: string;
  /** True if a brain page already claims this folder. */
  alreadyClaims: boolean;
  /** True if the base slug is taken by a different folder (we fell back to dated). */
  collided: boolean;
} {
  const m = /^(.+?)-(\d{4}-\d{2}-\d{2})$/.exec(project.folderName);
  const base = m ? m[1]! : project.folderName;
  const date = m ? m[2]! : null;

  if (!knownSlugs.has(base)) {
    return { slug: base, alreadyClaims: false, collided: false };
  }

  // Base is taken — does it point back at THIS folder?
  const fm = pageFrontmatterReader(base);
  const existingDataPath =
    (fm?.["data_path"] as string | undefined) ?? null;
  if (existingDataPath) {
    const expanded = expandHomePath(existingDataPath);
    const folderWithSlash = project.folderPath.endsWith("/")
      ? project.folderPath
      : project.folderPath + "/";
    if (
      pathsMatch(expanded, folderWithSlash) ||
      pathsMatch(expanded, project.folderPath)
    ) {
      return { slug: base, alreadyClaims: true, collided: false };
    }
  }

  // Different folder owns the base slug — fall back to dated.
  if (date) {
    const dated = `${base}-${date}`;
    return { slug: dated, alreadyClaims: knownSlugs.has(dated), collided: true };
  }
  return { slug: project.folderName, alreadyClaims: knownSlugs.has(project.folderName), collided: true };
}

function pathsMatch(a: string, b: string): boolean {
  if (a === b) return true;
  // macOS realpath prefixes /var with /private; tolerate either form.
  const stripPrivate = (s: string) =>
    s.startsWith("/private/var/") ? s.slice("/private".length) : s;
  return stripPrivate(a) === stripPrivate(b);
}
