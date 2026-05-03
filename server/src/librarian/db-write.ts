import { readFileSync, statSync } from "node:fs";
import type { Database } from "better-sqlite3";
import { openDb } from "../db/db.js";
import { findBlockIds, parseBlockId, extractBlock } from "../lib/blockId.js";
import { parseDoc } from "../lib/frontmatter.js";

/**
 * Write-side DB helpers for the librarian. The MCP server reads from
 * the same DB; only the librarian writes to `pages`/`blocks`/`captures`
 * content rows.
 */

export function indexPage(absPath: string, plane: string): void {
  const db = openDb();
  const raw = readFileSync(absPath, "utf8");
  const parsed = parseDoc(raw);
  const fm = parsed.data;
  const slug = (fm["slug"] as string | undefined) ?? deriveSlug(absPath);
  const title =
    (fm["title"] as string | undefined) ??
    /^#\s+(.+)/.exec(parsed.content)?.[1] ??
    slug;
  const status = fm["status"] as string | null;
  const lastUpdated = statSync(absPath).mtime.toISOString();
  upsertPage(db, {
    path: absPath,
    plane,
    slug,
    title,
    status,
    last_updated: lastUpdated,
    frontmatter: fm,
  });

  // Index blocks.
  const blockIds = findBlockIds(parsed.content);
  // Wipe and re-insert blocks for this page so deletions/renames are
  // reflected in FTS5.
  db.prepare("DELETE FROM blocks WHERE page_path = ?").run(absPath);
  db.prepare("DELETE FROM blocks_fts WHERE page_path = ?").run(absPath);
  for (const bid of blockIds) {
    const parsedId = parseBlockId(bid);
    if (!parsedId) continue;
    const sub = extractBlock(parsed.content, bid) ?? "";
    const headingMatch = /^(#{1,6})\s+(.+)/.exec(sub);
    const heading = headingMatch ? headingMatch[2]! : null;
    db.prepare(
      `INSERT INTO blocks (block_id, page_path, plane, slug, section, version, heading, body, last_updated)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      bid,
      absPath,
      parsedId.plane,
      parsedId.slug,
      parsedId.section,
      parsedId.version,
      heading,
      sub,
      lastUpdated,
    );
    db.prepare(
      `INSERT INTO blocks_fts (block_id, page_path, heading, body)
        VALUES (?, ?, ?, ?)`,
    ).run(bid, absPath, heading ?? "", sub);
  }
}

export function indexCapture(absPath: string): void {
  const db = openDb();
  const raw = readFileSync(absPath, "utf8");
  const parsed = parseDoc(raw);
  const fm = parsed.data;
  const sessionId = asString(fm["session_id"], "_unknown");
  const trigger = asString(fm["trigger"], "manual");
  const projectSlug = (fm["project_slug"] === undefined || fm["project_slug"] === null)
    ? null
    : asString(fm["project_slug"], "_unrouted");
  const createdAt = asString(fm["created_at"], new Date().toISOString());

  // Captures table is content-addressable on path.
  db.prepare(
    `INSERT INTO captures (path, session_id, trigger, project_slug, created_at, body)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        session_id=excluded.session_id,
        trigger=excluded.trigger,
        project_slug=excluded.project_slug,
        created_at=excluded.created_at,
        body=excluded.body`,
  ).run(absPath, sessionId, trigger, projectSlug, createdAt, parsed.content);

  // FTS5 doesn't support upsert; replace if exists.
  db.prepare("DELETE FROM captures_fts WHERE path = ?").run(absPath);
  db.prepare(
    "INSERT INTO captures_fts (path, body) VALUES (?, ?)",
  ).run(absPath, parsed.content);
}

export function markCaptureProcessed(
  absPath: string,
  newPath: string,
): void {
  const db = openDb();
  db.prepare(
    `UPDATE captures SET processed_at = ?, path = ? WHERE path = ?`,
  ).run(new Date().toISOString(), newPath, absPath);
  db.prepare(
    `UPDATE captures_fts SET path = ? WHERE path = ?`,
  ).run(newPath, absPath);
}

export function recordProvenance(
  blockId: string,
  capturePath: string,
  sessionId: string,
  trigger: string,
): void {
  const db = openDb();
  db.prepare(
    `INSERT OR IGNORE INTO provenance (block_id, capture_path, session_id, trigger, promoted_at)
      VALUES (?, ?, ?, ?, ?)`,
  ).run(blockId, capturePath, sessionId, trigger, new Date().toISOString());
}

/**
 * Persist (upsert) per-block metadata produced by the Sonnet
 * synthesizer + index it in the parallel FTS5 table for retrieval.
 */
export function indexBlockMetadata(
  pagePath: string,
  blockId: string,
  meta: {
    summary: string;
    aliases: string[];
    entities: string[];
    search_terms: string[];
  },
  promptSha: string | undefined,
): void {
  const db = openDb();
  const lastUpdated = new Date().toISOString();
  db.prepare(
    `INSERT INTO blocks_metadata (block_id, summary, aliases_json, entities_json, search_terms_json, last_updated, synthesizer_prompt_sha256)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(block_id) DO UPDATE SET
        summary=excluded.summary,
        aliases_json=excluded.aliases_json,
        entities_json=excluded.entities_json,
        search_terms_json=excluded.search_terms_json,
        last_updated=excluded.last_updated,
        synthesizer_prompt_sha256=excluded.synthesizer_prompt_sha256`,
  ).run(
    blockId,
    meta.summary,
    JSON.stringify(meta.aliases),
    JSON.stringify(meta.entities),
    JSON.stringify(meta.search_terms),
    lastUpdated,
    promptSha ?? null,
  );

  // FTS5 mirror — replace existing row if present.
  db.prepare("DELETE FROM blocks_meta_fts WHERE block_id = ?").run(blockId);
  db.prepare(
    `INSERT INTO blocks_meta_fts (block_id, page_path, summary, aliases, entities, search_terms)
      VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    blockId,
    pagePath,
    meta.summary,
    meta.aliases.join(" \n "),
    meta.entities.join(" \n "),
    meta.search_terms.join(" \n "),
  );
}

export function getBlockMetadata(blockId: string): {
  summary: string;
  aliases: string[];
  entities: string[];
  search_terms: string[];
} | null {
  const db = openDb();
  const row = db
    .prepare(
      "SELECT summary, aliases_json, entities_json, search_terms_json FROM blocks_metadata WHERE block_id = ?",
    )
    .get(blockId) as
    | {
        summary: string;
        aliases_json: string;
        entities_json: string;
        search_terms_json: string;
      }
    | undefined;
  if (!row) return null;
  try {
    return {
      summary: row.summary,
      aliases: JSON.parse(row.aliases_json),
      entities: JSON.parse(row.entities_json),
      search_terms: JSON.parse(row.search_terms_json),
    };
  } catch {
    return null;
  }
}

interface PageUpsert {
  path: string;
  plane: string;
  slug: string;
  title: string;
  status: string | null;
  last_updated: string;
  frontmatter: Record<string, unknown>;
}

function upsertPage(db: Database, p: PageUpsert): void {
  db.prepare(
    `INSERT INTO pages (path, plane, slug, title, last_updated, status, frontmatter_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        plane=excluded.plane,
        slug=excluded.slug,
        title=excluded.title,
        last_updated=excluded.last_updated,
        status=excluded.status,
        frontmatter_json=excluded.frontmatter_json`,
  ).run(
    p.path,
    p.plane,
    p.slug,
    p.title,
    p.last_updated,
    p.status,
    JSON.stringify(p.frontmatter),
  );
}

function deriveSlug(absPath: string): string {
  const file = absPath.split("/").pop() ?? absPath;
  return file.replace(/\.md$/, "");
}

/**
 * Coerce a YAML-parsed frontmatter value into a SQLite-bindable
 * string. YAML autodetection turns unquoted ISO timestamps into Date
 * objects, which `.run()` rejects.
 */
function asString(v: unknown, fallback: string): string {
  if (v === undefined || v === null) return fallback;
  if (typeof v === "string") return v;
  if (v instanceof Date) return v.toISOString();
  return String(v);
}
