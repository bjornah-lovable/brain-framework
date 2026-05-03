import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, relative } from "node:path";
import { vaultPaths, SYNTHESIZED_PLANES } from "../vault.js";
import { openDb } from "../../db/db.js";
import { findBlockIds } from "../blockId.js";

export interface Candidate {
  path: string;
  block_id?: string;
  source_type:
    | "synthesized_page"
    | "capture"
    | "raw"
    | "trajectory"
    | "evidence";
  heading?: string;
  snippet: string;
  last_updated: string;
  score: number;
  match_reason: string;
}

export interface CandidateInput {
  query: string;
  scope: ReadonlyArray<
    "projects" | "feed" | "knowledge" | "captures" | "trajectories" | "raw"
  >;
  project_slug?: string;
  freshness_cutoff_ms?: number;
  max_candidates: number;
}

/**
 * FTS5-backed candidate generation. If FTS tables are empty (e.g.
 * first run before the librarian has indexed anything), falls back
 * to a filesystem walk + substring match.
 */
export function generateCandidates(input: CandidateInput): Candidate[] {
  const db = openDb();
  const out: Candidate[] = [];

  const planes = input.scope.filter(
    (s): s is (typeof SYNTHESIZED_PLANES)[number] =>
      (SYNTHESIZED_PLANES as readonly string[]).includes(s),
  );

  if (planes.length > 0) {
    const ftsCount = db
      .prepare("SELECT COUNT(*) AS n FROM blocks_fts")
      .get() as { n: number };
    if (ftsCount.n > 0) {
      const ftsQuery = ftsToken(input.query);
      const planeFilter = planes
        .map((p) => `'${p === "projects" ? "project" : p === "feed" ? "feed" : "knowledge"}'`)
        .join(",");

      // Body+heading FTS over blocks_fts.
      const bodyRows = db
        .prepare(
          `SELECT b.block_id, b.page_path, b.heading, b.body, b.last_updated,
                  bm25(blocks_fts) AS rank
             FROM blocks_fts
             JOIN blocks b ON b.block_id = blocks_fts.block_id
            WHERE blocks_fts MATCH ?
              AND b.plane IN (${planeFilter})
            ORDER BY rank ASC
            LIMIT ?`,
        )
        .all(ftsQuery, input.max_candidates) as Array<{
        block_id: string;
        page_path: string;
        heading: string;
        body: string;
        last_updated: string;
        rank: number;
      }>;
      for (const r of bodyRows) {
        out.push({
          path: r.page_path,
          block_id: r.block_id,
          source_type: "synthesized_page",
          heading: r.heading,
          snippet: snippetFor(r.body, input.query),
          last_updated: r.last_updated,
          score: -r.rank,
          match_reason: "fts5-body",
        });
      }

      // Metadata FTS over blocks_meta_fts (summary, aliases, entities,
      // search_terms). Often catches the recall cases body alone misses.
      const metaCount = db
        .prepare("SELECT COUNT(*) AS n FROM blocks_meta_fts")
        .get() as { n: number };
      if (metaCount.n > 0) {
        const metaRows = db
          .prepare(
            `SELECT b.block_id, b.page_path, b.heading, b.body, b.last_updated,
                    bm25(blocks_meta_fts) AS rank
               FROM blocks_meta_fts
               JOIN blocks b ON b.block_id = blocks_meta_fts.block_id
              WHERE blocks_meta_fts MATCH ?
                AND b.plane IN (${planeFilter})
              ORDER BY rank ASC
              LIMIT ?`,
          )
          .all(ftsQuery, input.max_candidates) as Array<{
          block_id: string;
          page_path: string;
          heading: string;
          body: string;
          last_updated: string;
          rank: number;
        }>;
        for (const r of metaRows) {
          out.push({
            path: r.page_path,
            block_id: r.block_id,
            source_type: "synthesized_page",
            heading: r.heading,
            snippet: snippetFor(r.body, input.query),
            last_updated: r.last_updated,
            // Slight boost for metadata matches relative to body so the
            // dedup keeps the metadata-tagged candidate when both fire.
            score: -r.rank + 0.1,
            match_reason: "fts5-metadata",
          });
        }
      }
    } else {
      out.push(...filesystemFallback(input, planes));
    }
  }

  if (input.scope.includes("captures")) {
    const ftsCount = db
      .prepare("SELECT COUNT(*) AS n FROM captures_fts")
      .get() as { n: number };
    if (ftsCount.n > 0) {
      const ftsQuery = ftsToken(input.query);
      const rows = db
        .prepare(
          `SELECT c.path, c.body, c.created_at, bm25(captures_fts) AS rank
             FROM captures_fts
             JOIN captures c ON c.path = captures_fts.path
            WHERE captures_fts MATCH ?
            ORDER BY rank ASC
            LIMIT ?`,
        )
        .all(ftsQuery, Math.max(2, Math.floor(input.max_candidates / 2))) as Array<{
        path: string;
        body: string;
        created_at: string;
        rank: number;
      }>;
      for (const r of rows) {
        out.push({
          path: r.path,
          source_type: "capture",
          snippet: snippetFor(r.body, input.query),
          last_updated: r.created_at,
          score: -r.rank,
          match_reason: "fts5-captures",
        });
      }
    }
  }

  // De-dup by path+block_id and keep best score.
  const dedup = new Map<string, Candidate>();
  for (const c of out) {
    const key = `${c.path}#${c.block_id ?? ""}`;
    const prev = dedup.get(key);
    if (!prev || prev.score < c.score) dedup.set(key, c);
  }
  return [...dedup.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, input.max_candidates);
}

/**
 * Quote terms with double quotes to disable FTS5 operator parsing,
 * preventing untrusted query strings from triggering syntax errors.
 */
function ftsToken(query: string): string {
  const cleaned = query.replace(/"/g, " ").trim();
  if (cleaned.length === 0) return '""';
  const tokens = cleaned.split(/\s+/).filter((t) => t.length > 0);
  return tokens.map((t) => `"${t}"`).join(" ");
}

function snippetFor(body: string, query: string): string {
  const lower = body.toLowerCase();
  const q = query.toLowerCase().split(/\s+/).filter(Boolean)[0] ?? "";
  if (!q) return body.slice(0, 200);
  const idx = lower.indexOf(q);
  if (idx === -1) return body.slice(0, 200);
  const start = Math.max(0, idx - 80);
  const end = Math.min(body.length, idx + 160);
  return (start > 0 ? "…" : "") + body.slice(start, end) + (end < body.length ? "…" : "");
}

/**
 * Filesystem fallback used before the librarian has indexed anything.
 * Walks each requested plane shallowly and matches on substring.
 */
function filesystemFallback(
  input: CandidateInput,
  planes: ReadonlyArray<"projects" | "feed" | "knowledge">,
): Candidate[] {
  const v = vaultPaths();
  const out: Candidate[] = [];
  const q = input.query.toLowerCase();
  for (const plane of planes) {
    const dir =
      plane === "projects"
        ? v.projects
        : plane === "feed"
          ? v.feed
          : v.knowledge;
    let entries: string[];
    try {
      entries = walk(dir);
    } catch {
      continue;
    }
    for (const path of entries) {
      if (!path.endsWith(".md")) continue;
      let body: string;
      try {
        body = readFileSync(path, "utf8");
      } catch {
        continue;
      }
      const lower = body.toLowerCase();
      if (!lower.includes(q)) continue;
      const blockIds = findBlockIds(body);
      out.push({
        path: relative(v.root, path),
        block_id: blockIds[0],
        source_type: "synthesized_page",
        snippet: snippetFor(body, input.query),
        last_updated: statSync(path).mtime.toISOString(),
        score: 1,
        match_reason: "fs-substring",
      });
      if (out.length >= input.max_candidates) return out;
    }
  }
  return out;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(path));
    else if (entry.isFile()) out.push(path);
  }
  return out;
}
