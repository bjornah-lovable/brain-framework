import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { vaultPaths } from "../lib/vault.js";
import { parseDoc, stringifyDoc } from "../lib/frontmatter.js";

/**
 * Project page templating + append helpers.
 *
 * The librarian writes synthesized planes. Tier-1 deterministic
 * implementation: each capture's section bullets get appended to the
 * corresponding section block on the project page. Block IDs and
 * sidecar provenance are real; the prose is just concatenated bullets,
 * not Sonnet-synthesized — that's the next phase.
 */

export const PROJECT_SECTIONS = [
  { heading: "Where we are", id: "where-we-are", kind: "where_we_are" },
  { heading: "Open blockers / next actions", id: "blockers", kind: "blockers" },
  { heading: "Recent updates", id: "recent-updates", kind: "recent_updates" },
  { heading: "Artifacts", id: "artifacts", kind: "artifacts" },
] as const;

export type SectionKind = (typeof PROJECT_SECTIONS)[number]["kind"];
export type SectionId = (typeof PROJECT_SECTIONS)[number]["id"];

const CAPTURE_TO_SECTION: Record<string, SectionId> = {
  decision: "recent-updates",
  finding: "recent-updates",
  state_change: "where-we-are",
  blocker: "blockers",
  open_question: "blockers",
};

export function sectionForCaptureKind(
  kind: string | undefined,
): SectionId {
  if (kind && kind in CAPTURE_TO_SECTION) return CAPTURE_TO_SECTION[kind]!;
  return "recent-updates";
}

export function sectionKindFor(id: SectionId): SectionKind {
  for (const s of PROJECT_SECTIONS) {
    if (s.id === id) return s.kind;
  }
  return "recent_updates";
}

export function projectBlockId(slug: string, sectionId: SectionId): string {
  return `project.${slug}.${sectionId}.v1`;
}

export function blockIdComment(id: string): string {
  return `<!-- brain:block ${id} -->`;
}

export interface AppendItem {
  /** Body of the capture, raw markdown. */
  body: string;
  /** Capture filename (relative to vault root). */
  capture_path: string;
  /** Frontmatter capture_kind, if any. */
  capture_kind?: string;
  /** ISO timestamp. */
  created_at: string;
}

export function projectPagePath(slug: string): string {
  const v = vaultPaths();
  return resolve(v.projects, `${slug}.md`);
}

/**
 * Read or initialise a project page. If missing, create a skeleton
 * with all four sections + their stable block IDs.
 */
export function ensureProjectPage(slug: string): {
  path: string;
  body: string;
  data: Record<string, unknown>;
} {
  const path = projectPagePath(slug);
  if (existsSync(path)) {
    const raw = readFileSync(path, "utf8");
    const parsed = parseDoc(raw);
    return { path, body: parsed.content, data: parsed.data };
  }
  const v = vaultPaths();
  mkdirSync(dirname(path), { recursive: true });
  const data: Record<string, unknown> = {
    slug,
    last_touched: new Date().toISOString(),
    status: "active",
  };
  const sections = PROJECT_SECTIONS.map(
    (s) =>
      `## ${s.heading}\n${blockIdComment(projectBlockId(slug, s.id))}\n\n_(no entries yet)_\n`,
  ).join("\n");
  const title = slug
    .split(/[-_]/)
    .map((w) => (w[0]?.toUpperCase() ?? "") + w.slice(1))
    .join(" ");
  const body = `# ${title}\n\n${sections}`;
  writeFileSync(path, stringifyDoc(data, body), "utf8");
  // also ensure ~/brain/projects/ exists
  void v;
  return { path, body, data };
}

/**
 * Append a one-line bullet to the appropriate section, based on
 * capture_kind. Updates `last_touched` in frontmatter.
 *
 * Returns the block_id that received the entry.
 */
export function appendToProjectPage(
  slug: string,
  item: AppendItem,
): { block_id: string; path: string } {
  const path = projectPagePath(slug);
  const sectionId = sectionForCaptureKind(item.capture_kind);

  const raw = readFileSync(path, "utf8");
  const parsed = parseDoc(raw);
  let body = parsed.content;
  const blockId = projectBlockId(slug, sectionId);
  const marker = blockIdComment(blockId);

  if (!body.includes(marker)) {
    // Section missing — re-init the page and recurse.
    ensureProjectPage(slug);
    return appendToProjectPage(slug, item);
  }

  const date = item.created_at.slice(0, 10);
  const summaryLines = extractSummaryBullets(item.body, item.capture_kind);
  const datedBullet =
    summaryLines.length === 0
      ? `- _(${date}, ${shortName(item.capture_path)}: no extractable bullets)_`
      : summaryLines.map((l) => `- ${date} — ${l}`).join("\n");

  body = insertAfterMarker(
    body,
    marker,
    datedBullet,
    /* placeholder */ "_(no entries yet)_",
  );

  const data = { ...parsed.data, last_touched: new Date().toISOString() };
  writeFileSync(path, stringifyDoc(data, body), "utf8");
  return { block_id: blockId, path };
}

/**
 * Pull bullets from the capture body. Tier-1 heuristic: take the first
 * three bullets from the section that matches `capture_kind`, falling
 * back to the first three from the whole document.
 */
function extractSummaryBullets(body: string, kind?: string): string[] {
  const sections = splitSections(body);
  const target =
    kind === "decision"
      ? "Decisions"
      : kind === "finding"
        ? "Findings"
        : kind === "blocker" || kind === "open_question"
          ? "Blockers"
          : kind === "state_change"
            ? "State"
            : null;
  let pool: string[] = [];
  if (target) {
    for (const sec of sections) {
      if (sec.heading.toLowerCase().includes(target.toLowerCase())) {
        pool = bulletLines(sec.body);
        break;
      }
    }
  }
  if (pool.length === 0) pool = bulletLines(body);
  return pool.slice(0, 3);
}

function splitSections(body: string): { heading: string; body: string }[] {
  const out: { heading: string; body: string }[] = [];
  const lines = body.split("\n");
  let cur: { heading: string; lines: string[] } | null = null;
  for (const line of lines) {
    const m = /^(#{2,3})\s+(.+)/.exec(line);
    if (m) {
      if (cur) out.push({ heading: cur.heading, body: cur.lines.join("\n") });
      cur = { heading: m[2]!, lines: [] };
    } else if (cur) {
      cur.lines.push(line);
    }
  }
  if (cur) out.push({ heading: cur.heading, body: cur.lines.join("\n") });
  return out;
}

function bulletLines(body: string): string[] {
  return body
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("- "))
    .map((l) => l.slice(2).trim())
    .filter((l) => l.length > 0);
}

function shortName(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] ?? path;
}

function insertAfterMarker(
  body: string,
  marker: string,
  newContent: string,
  placeholder: string,
): string {
  const idx = body.indexOf(marker);
  if (idx === -1) return body;
  const after = idx + marker.length;
  // Find the end of the section: next blank line + "## " or end of file.
  let sectionEnd = body.length;
  const nextHeader = body.indexOf("\n## ", after);
  if (nextHeader !== -1) sectionEnd = nextHeader;
  const sectionBody = body.slice(after, sectionEnd);
  const updatedSection = sectionBody.includes(placeholder)
    ? sectionBody.replace(placeholder, newContent)
    : `${sectionBody.replace(/\s+$/, "")}\n${newContent}\n`;
  return body.slice(0, after) + updatedSection + body.slice(sectionEnd);
}

/**
 * Extract the markdown subtree for a block (heading + comment + body
 * up to the next ## header). Used to feed `current_block_body` to the
 * Sonnet synthesizer.
 */
export function readBlockBody(
  pageBody: string,
  blockId: string,
): string | null {
  const marker = blockIdComment(blockId);
  const markerIdx = pageBody.indexOf(marker);
  if (markerIdx === -1) return null;
  // Find the heading line directly above the marker (skipping blanks).
  let headStart = pageBody.lastIndexOf("\n## ", markerIdx);
  if (headStart === -1) headStart = pageBody.lastIndexOf("## ", markerIdx);
  if (headStart === -1) return null;
  if (headStart > 0 && pageBody[headStart] === "\n") headStart += 1;
  // End: next ## header after the marker, or end of file.
  let blockEnd = pageBody.indexOf("\n## ", markerIdx);
  if (blockEnd === -1) blockEnd = pageBody.length;
  return pageBody.slice(headStart, blockEnd).replace(/\s+$/, "");
}

/**
 * Stamp `import_source_sha256` (and update `last_touched`) on a project
 * page's frontmatter, preserving everything else. Used by
 * `applySynthesisResults` after promoting an import-derived plan.
 */
export function setImportSourceSha(
  slug: string,
  sha: string,
): { path: string; ok: boolean } {
  const path = projectPagePath(slug);
  if (!existsSync(path)) return { path, ok: false };
  const raw = readFileSync(path, "utf8");
  const parsed = parseDoc(raw);
  const data = {
    ...parsed.data,
    import_source_sha256: sha,
    last_touched: new Date().toISOString(),
  };
  writeFileSync(path, stringifyDoc(data, parsed.content), "utf8");
  return { path, ok: true };
}

/**
 * Write a fresh project-page skeleton with imported frontmatter. Used
 * by `import-pointers`. If the page already exists, returns
 * `{created: false}` and leaves the existing content untouched.
 */
export function writeImportedPointer(
  slug: string,
  frontmatter: Record<string, unknown>,
): { path: string; created: boolean } {
  const path = projectPagePath(slug);
  if (existsSync(path)) return { path, created: false };
  mkdirSync(dirname(path), { recursive: true });
  const sections = PROJECT_SECTIONS.map(
    (s) =>
      `## ${s.heading}\n${blockIdComment(projectBlockId(slug, s.id))}\n\n_(import — content not yet synthesized)_\n`,
  ).join("\n");
  const title = slug
    .split(/[-_]/)
    .map((w) => (w[0]?.toUpperCase() ?? "") + w.slice(1))
    .join(" ");
  const body = `# ${title}\n\n${sections}`;
  writeFileSync(path, stringifyDoc(frontmatter, body), "utf8");
  return { path, created: true };
}

export function readPageFrontmatter(slug: string): Record<string, unknown> | null {
  const path = projectPagePath(slug);
  if (!existsSync(path)) return null;
  try {
    return parseDoc(readFileSync(path, "utf8")).data;
  } catch {
    return null;
  }
}

/**
 * Replace one block in the page body. The new body is expected to
 * include the heading line and the <!-- brain:block ... --> comment;
 * we anchor on the marker so heading-text edits flow through.
 */
export function replaceBlockInPage(
  slug: string,
  sectionId: SectionId,
  newBlockBody: string,
): { path: string; replaced: boolean } {
  const path = projectPagePath(slug);
  const raw = readFileSync(path, "utf8");
  const parsed = parseDoc(raw);
  const body = parsed.content;
  const blockId = projectBlockId(slug, sectionId);
  const marker = blockIdComment(blockId);
  const markerIdx = body.indexOf(marker);
  if (markerIdx === -1) return { path, replaced: false };

  let headStart = body.lastIndexOf("\n## ", markerIdx);
  if (headStart === -1) headStart = body.lastIndexOf("## ", markerIdx);
  if (headStart === -1) return { path, replaced: false };
  if (headStart > 0 && body[headStart] === "\n") headStart += 1;
  let blockEnd = body.indexOf("\n## ", markerIdx);
  if (blockEnd === -1) blockEnd = body.length;

  const before = body.slice(0, headStart);
  const after = body.slice(blockEnd);
  // Ensure exactly one blank line between this block and the next.
  const trimmedNew = newBlockBody.replace(/\s+$/, "");
  const sep = after.startsWith("\n## ") ? "\n\n" : "\n";
  const newPageBody = `${before}${trimmedNew}${sep}${after.replace(/^\n+/, "")}`;

  const data = { ...parsed.data, last_touched: new Date().toISOString() };
  writeFileSync(path, stringifyDoc(data, newPageBody), "utf8");
  return { path, replaced: true };
}
