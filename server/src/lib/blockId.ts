/**
 * Stable block IDs anchor sidecar provenance to sections of synthesized
 * pages even when display headings get edited.
 *
 * Grammar: project.<slug>.<section>.v<integer>
 *   slug:     [a-z0-9-]+
 *   section:  [a-z0-9-]+
 *   v<int>:   schema version of the section's *meaning*
 *
 * Example: project.stuck-mitigation.where-we-are.v3
 *
 * In Markdown, the ID is emitted as an HTML comment immediately
 * under the section heading:
 *
 *     ## Where we are
 *     <!-- brain:block project.stuck-mitigation.where-we-are.v3 -->
 *
 * `feed` was removed from the plane union 2026-05-15 and
 * `knowledge | topic` were removed 2026-06-27 when those planes were
 * retired (SCHEMA.md "Retired planes"). No block IDs in those planes
 * were ever produced, so no existing IDs lose parseability.
 */

const BLOCK_ID_RE =
  /^(project)\.([A-Za-z0-9_-]+)\.([a-z0-9-]+)\.v(\d+)$/;

const COMMENT_RE = /<!--\s*brain:block\s+([^\s]+)\s*-->/g;

export interface BlockId {
  readonly raw: string;
  readonly plane: "project";
  readonly slug: string;
  readonly section: string;
  readonly version: number;
}

export function parseBlockId(raw: string): BlockId | null {
  const m = BLOCK_ID_RE.exec(raw);
  if (!m) return null;
  return {
    raw,
    plane: m[1] as BlockId["plane"],
    slug: m[2]!,
    section: m[3]!,
    version: Number.parseInt(m[4]!, 10),
  };
}

export function formatBlockId(b: Omit<BlockId, "raw">): string {
  return `${b.plane}.${b.slug}.${b.section}.v${b.version}`;
}

export function blockIdComment(id: string): string {
  return `<!-- brain:block ${id} -->`;
}

/**
 * Find every block ID in a markdown body. Useful for indexing and
 * for `brain-read --block <id>` retrieval.
 */
export function findBlockIds(markdown: string): string[] {
  const out: string[] = [];
  COMMENT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = COMMENT_RE.exec(markdown)) !== null) {
    if (m[1]) out.push(m[1]);
  }
  return out;
}

/**
 * Extract the markdown subtree for a given block ID. Returns the
 * heading line, the block-id comment line, and everything until the
 * next heading of the same or shallower depth (or end of file).
 */
export function extractBlock(
  markdown: string,
  blockId: string,
): string | null {
  const lines = markdown.split("\n");
  const target = blockIdComment(blockId);
  let startIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === target || lines[i]?.includes(target)) {
      startIdx = i;
      break;
    }
  }
  if (startIdx === -1) return null;

  // Walk up to find the heading line.
  let headingIdx = startIdx;
  for (let i = startIdx - 1; i >= 0; i--) {
    if (/^#{1,6}\s+/.test(lines[i] ?? "")) {
      headingIdx = i;
      break;
    }
    if (i < startIdx - 3) break;
  }
  const headingMatch = /^(#{1,6})\s+/.exec(lines[headingIdx] ?? "");
  const depth = headingMatch ? headingMatch[1]!.length : 0;

  // Walk forward until next heading of same or shallower depth.
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    const m = /^(#{1,6})\s+/.exec(lines[i] ?? "");
    if (m && m[1]!.length <= depth) {
      endIdx = i;
      break;
    }
  }
  return lines.slice(headingIdx, endIdx).join("\n");
}
