import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { parseDoc } from "../frontmatter.js";
import { vaultPaths } from "../vault.js";
import type { Candidate } from "./candidates.js";

/**
 * "Where are we on project X?" used to be answered by a librarian-
 * maintained stored block (PLAN_v3 §1.5d). That arrangement went
 * stale between scheduled consolidation runs and re-paid the
 * synthesis cost for every active project regardless of read demand.
 * As of PLAN_v3 delta #15 it's served on demand by the
 * `brain-search` broker.
 *
 * This module supplies the where-we-are-specific machinery used by
 * the broker:
 *
 *   - {@link buildWhereWeAreCandidates}: gather the project page +
 *     recent processed captures + frontmatter as the candidate set.
 *     No LLM; pure filesystem.
 *
 *   - {@link readWhereWeAreCache} / {@link writeWhereWeAreCache}:
 *     persist the synthesized dossier under
 *     `.brain/search/cache/where-we-are/<slug>.json` keyed on the
 *     project page's mtime. A cache hit returns the prior dossier
 *     verbatim — zero new LLM work until the page is touched again.
 *
 *   - {@link projectLastTouchedMs}: cache invalidation key.
 *
 * Single-writer-librarian invariant is preserved — we only write to
 * `.brain/`, never to a synthesized plane.
 */

export interface WhereWeAreCacheEntry {
  project_slug: string;
  project_last_touched_ms: number;
  /** sha256 of the project page body content. Distinguishes inode-only
   *  mtime bumps (git checkout, rsync) from real content changes. */
  page_content_sha256: string;
  prompt_sha256: string;
  cached_at: string;
  /** Verbatim dossier stored by the broker on finalise. */
  dossier: unknown;
}

const MAX_RECENT_CAPTURES = 8;
/** Absolute cache lifetime. Bjorn's design rejection of the prior
 *  stored-block approach was specifically about unbounded staleness;
 *  the broker's mtime invalidation handles "content changed" cases,
 *  but a project page that's been mtime-stable for months can still
 *  diverge from external reality (PRs merged, tickets closed). 7 days
 *  bounds the worst-case staleness without re-paying every read. */
const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** sha256 of a project page's body. The body is small enough (<50KB
 *  typical) that the hash is microseconds; making the cache key
 *  content-aware lets git-checkout-induced mtime bumps still hit the
 *  cache when bytes are unchanged. */
export function projectPageContentSha256(projectSlug: string): string {
  const v = vaultPaths();
  const path = resolve(v.projects, `${projectSlug}.md`);
  if (!existsSync(path)) return "";
  try {
    const raw = readFileSync(path, "utf8");
    return createHash("sha256").update(raw).digest("hex");
  } catch {
    return "";
  }
}

/** Read mtime of the project page in ms-since-epoch, or 0 if missing. */
export function projectLastTouchedMs(projectSlug: string): number {
  const v = vaultPaths();
  const path = resolve(v.projects, `${projectSlug}.md`);
  if (!existsSync(path)) return 0;
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Build the candidate set for `intent=where_are_we project_slug=X`.
 * Deterministic — no LLM, no FTS5. Includes:
 *
 *   1. The full project page body (one Candidate, source_type =
 *      `synthesized_page`, snippet = a compact excerpt of Blockers +
 *      Recent updates).
 *   2. The N most-recent processed captures targeting this project
 *      (source_type = `capture`).
 *
 * If the page doesn't exist, returns an empty list — the broker's
 * fast-path will surface that as "project not yet on the brain".
 */
export function buildWhereWeAreCandidates(
  projectSlug: string,
): Candidate[] {
  const v = vaultPaths();
  const out: Candidate[] = [];

  const pagePath = resolve(v.projects, `${projectSlug}.md`);
  if (existsSync(pagePath)) {
    try {
      const raw = readFileSync(pagePath, "utf8");
      const parsed = parseDoc(raw);
      const st = statSync(pagePath);
      const status = String(parsed.data["status"] ?? "active");
      const lastTouched = String(parsed.data["last_touched"] ?? st.mtime.toISOString());
      out.push({
        path: `projects/${projectSlug}.md`,
        source_type: "synthesized_page",
        heading: `${projectSlug} (status=${status})`,
        snippet: compactPageExcerpt(parsed.content),
        last_updated: lastTouched,
        score: 1,
        match_reason: "where-we-are-page",
      });
    } catch {
      // Best-effort. If the page can't be parsed, the captures alone
      // still give the broker something to work with.
    }
  }

  // Walk processed captures most-recent-first; keep those that name
  // the project_slug in their frontmatter. The processed dir is the
  // immutable archive of every consolidated capture (PLAN_v3 §1 #3 /
  // SCHEMA "raw is append-only" applies to its companion path).
  const processedDir = v.processed;
  if (existsSync(processedDir)) {
    let entries: string[];
    try {
      entries = readdirSync(processedDir).filter((f) => f.endsWith(".md"));
    } catch {
      entries = [];
    }
    const dated: Array<{ fname: string; mtime: number }> = [];
    for (const fname of entries) {
      try {
        const st = statSync(resolve(processedDir, fname));
        dated.push({ fname, mtime: st.mtimeMs });
      } catch {
        // skip
      }
    }
    dated.sort((a, b) => b.mtime - a.mtime);

    let picked = 0;
    for (const { fname, mtime } of dated) {
      if (picked >= MAX_RECENT_CAPTURES) break;
      const abs = resolve(processedDir, fname);
      let raw: string;
      try {
        raw = readFileSync(abs, "utf8");
      } catch {
        continue;
      }
      let parsed: ReturnType<typeof parseDoc>;
      try {
        parsed = parseDoc(raw);
      } catch {
        continue;
      }
      const slug = parsed.data["project_slug"];
      if (typeof slug !== "string" || slug !== projectSlug) continue;
      out.push({
        path: `.brain/processed/${fname}`,
        source_type: "capture",
        heading: String(parsed.data["capture_kind"] ?? "capture"),
        snippet: compactCaptureExcerpt(parsed.content),
        last_updated: new Date(mtime).toISOString(),
        score: 1,
        match_reason: "where-we-are-capture",
      });
      picked += 1;
    }
  }

  return out;
}

function compactPageExcerpt(body: string): string {
  // Pull a tight structured excerpt. Total cap at ~1500 chars so a
  // fat project page doesn't blow the candidate snippet budget.
  const blockers = pickBullets(body, "Open blockers / next actions", 3);
  const recent = pickBullets(body, "Recent updates", 3);
  const artifacts = pickBullets(body, "Artifacts", 3);
  const parts: string[] = [];
  if (blockers.length > 0) parts.push("OPEN:\n" + blockers.join("\n"));
  if (recent.length > 0) parts.push("RECENT:\n" + recent.join("\n"));
  if (artifacts.length > 0) parts.push("ARTIFACTS:\n" + artifacts.join("\n"));
  const joined = parts.join("\n\n");
  return joined.length > 1500 ? joined.slice(0, 1500) + "…" : joined;
}

function pickBullets(body: string, sectionHeading: string, n: number): string[] {
  const headIdx = body.indexOf(`## ${sectionHeading}`);
  if (headIdx === -1) return [];
  const nextSection = body.indexOf("\n## ", headIdx + 1);
  const slice = body.slice(headIdx, nextSection === -1 ? undefined : nextSection);
  const lines = slice.split("\n").filter((l) => l.startsWith("- "));
  return lines.slice(0, n);
}

function compactCaptureExcerpt(body: string): string {
  // Strip section headings; keep enough content for the synthesizer
  // to see the substantive section even when captures lead with a
  // short summary paragraph. Bjorn's typical capture is 200-500
  // words = ~1500-3500 chars; 800 captures the lead + first
  // substantive section.
  const trimmed = body.replace(/^#+\s+.*$/gm, "").replace(/^\s+/, "");
  return trimmed.length > 800 ? trimmed.slice(0, 800) + "…" : trimmed;
}

/* ───────────────────────── cache ───────────────────────── */

const CACHE_FORMAT_VERSION = 1;

function cacheDir(): string {
  return resolve(vaultPaths().dot, "search", "cache", "where-we-are");
}

function cachePath(projectSlug: string): string {
  return resolve(cacheDir(), `${projectSlug}.json`);
}

export function readWhereWeAreCache(
  projectSlug: string,
  expectedContentSha256: string,
  expectedPromptSha256: string,
): WhereWeAreCacheEntry | null {
  const path = cachePath(projectSlug);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf8");
    const obj = JSON.parse(raw) as Partial<WhereWeAreCacheEntry> & {
      _format?: number;
    };
    if (obj._format !== CACHE_FORMAT_VERSION) return null;
    if (obj.project_slug !== projectSlug) return null;
    if (obj.page_content_sha256 !== expectedContentSha256) return null;
    if (obj.prompt_sha256 !== expectedPromptSha256) return null;
    if (!obj.dossier) return null;
    // Absolute-age TTL: prevent serving a dossier from months ago
    // even if the project page hasn't moved. Treat absent/unparseable
    // `cached_at` as expired — defaulting to "valid" would silently
    // bypass the TTL on legacy entries written before this check
    // existed and on any corrupted file.
    const cachedAtMs = obj.cached_at ? Date.parse(obj.cached_at) : NaN;
    if (!Number.isFinite(cachedAtMs)) return null;
    if (Date.now() - cachedAtMs > CACHE_MAX_AGE_MS) return null;
    return {
      project_slug: obj.project_slug,
      project_last_touched_ms: obj.project_last_touched_ms ?? 0,
      page_content_sha256: obj.page_content_sha256,
      prompt_sha256: obj.prompt_sha256,
      cached_at: obj.cached_at ?? "",
      dossier: obj.dossier,
    };
  } catch {
    return null;
  }
}

export function writeWhereWeAreCache(entry: WhereWeAreCacheEntry): void {
  const dir = cacheDir();
  mkdirSync(dir, { recursive: true });
  const path = cachePath(entry.project_slug);
  const payload = {
    _format: CACHE_FORMAT_VERSION,
    ...entry,
  };
  // Atomic write: tmp + rename. Concurrent finalises still race on
  // last-writer-wins for the final filename, but each one produces a
  // complete, valid file rather than a half-written one.
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf8");
  try {
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // Best-effort cleanup.
    }
    throw err;
  }
}

/**
 * Fingerprint helper. The prompt sha alone wouldn't fully invalidate
 * on candidate-set drift; combining slug + page mtime + prompt sha
 * makes the cache key dependent on every input the synthesizer saw.
 */
export function whereWeAreCacheKey(
  projectSlug: string,
  lastTouchedMs: number,
  promptSha: string,
): string {
  return createHash("sha256")
    .update(`${projectSlug}|${lastTouchedMs}|${promptSha}`)
    .digest("hex")
    .slice(0, 16);
}
