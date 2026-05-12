import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { parseDoc, stringifyDoc } from "../lib/frontmatter.js";
import { appendOpLog } from "../lib/log.js";
import { vaultPaths } from "../lib/vault.js";

/**
 * One-shot (but idempotent) sweep that removes the legacy
 * `## Where we are` block from every project page. As of PLAN_v3
 * delta #15 the question is served on demand by `brain-search
 * intent=where_are_we`; legacy stored blocks are unmaintained and
 * mostly stale or empty.
 *
 * Substantive block content (anything beyond `_(no entries yet)_`
 * or the import placeholder) is archived to
 * `.brain/needs-review/legacy-where-we-are/<slug>.md` BEFORE the
 * section is removed from the page. Empty-only blocks are deleted
 * without an audit file.
 *
 * Atomic page rewrite via tmp+rename. Caller must hold the
 * librarian lock — the CLI subcommand `sweep-legacy-where-we-are`
 * acquires it, mirroring the convention used by `lint`.
 *
 * Idempotent: after a successful run, pages have no
 * `Where we are` block and the marker text isn't found. Re-running
 * is a no-op for those pages.
 */
export interface LegacySweepResult {
  pages_examined: number;
  blocks_removed: number;
  substantive_archived: number;
  empty_removed: number;
  errors: number;
}

const EMPTY_PLACEHOLDERS = new Set([
  "_(no entries yet)_",
  "_(import — content not yet synthesized)_",
]);

const WHERE_WE_ARE_MARKER_RE =
  /<!--\s*brain:block\s+project\.[^.]+\.where-we-are\.v\d+\s*-->/;

export function sweepLegacyWhereWeAre(): LegacySweepResult {
  const v = vaultPaths();
  const result: LegacySweepResult = {
    pages_examined: 0,
    blocks_removed: 0,
    substantive_archived: 0,
    empty_removed: 0,
    errors: 0,
  };

  if (!existsSync(v.projects)) return result;

  let entries: string[];
  try {
    entries = readdirSync(v.projects).filter((f) => f.endsWith(".md"));
  } catch {
    result.errors += 1;
    return result;
  }

  const archiveDir = resolve(v.needsReview, "legacy-where-we-are");

  for (const fname of entries) {
    result.pages_examined += 1;
    const slug = fname.replace(/\.md$/, "");
    const pagePath = resolve(v.projects, fname);

    let raw: string;
    try {
      raw = readFileSync(pagePath, "utf8");
    } catch {
      result.errors += 1;
      continue;
    }

    let parsed: ReturnType<typeof parseDoc>;
    try {
      parsed = parseDoc(raw);
    } catch {
      result.errors += 1;
      continue;
    }

    const body = parsed.content;

    // Locate the section that contains the Where-we-are marker. We
    // anchor on the marker (not the heading text) so heading-text
    // drift doesn't matter. Section spans from the preceding `## `
    // heading line through the next `## ` heading or EOF.
    const markerMatch = WHERE_WE_ARE_MARKER_RE.exec(body);
    if (!markerMatch) continue;
    const markerIdx = markerMatch.index;
    let headStart = body.lastIndexOf("\n## ", markerIdx);
    if (headStart === -1) headStart = body.lastIndexOf("## ", markerIdx);
    if (headStart === -1) {
      result.errors += 1;
      continue;
    }
    if (headStart > 0 && body[headStart] === "\n") headStart += 1;
    let blockEnd = body.indexOf("\n## ", markerIdx);
    if (blockEnd === -1) blockEnd = body.length;
    else blockEnd += 1; // include the trailing newline before next ##

    const sectionText = body.slice(headStart, blockEnd);
    // The "body" of the block: everything after the marker line up to
    // the next ##, trimmed.
    const afterMarkerIdx = markerIdx + markerMatch[0].length;
    const blockBody = body
      .slice(afterMarkerIdx, blockEnd === body.length ? blockEnd : blockEnd - 1)
      .trim();

    const isEmpty = !blockBody || EMPTY_PLACEHOLDERS.has(blockBody);

    if (!isEmpty) {
      // Archive before removal. Idempotent suffix lets re-runs (or
      // partial-failure retries) coexist without overwriting.
      try {
        mkdirSync(archiveDir, { recursive: true });
        const archivePath = resolve(archiveDir, `${slug}.md`);
        const archive =
          `---\n` +
          `slug: ${slug}\n` +
          `archived_at: ${new Date().toISOString()}\n` +
          `source: projects/${slug}.md\n` +
          `note: legacy "Where we are" block — see PLAN_v3 §0 delta #15. The on-demand replacement is \`brain-search intent=where_are_we project_slug=${slug}\`.\n` +
          `---\n\n` +
          sectionText.replace(/\s+$/, "") +
          "\n";
        if (existsSync(archivePath)) {
          // Don't clobber an existing audit; append a unique suffix.
          const uniq = resolve(
            archiveDir,
            `${slug}-${Date.now()}-${randomBytes(4).toString("hex")}.md`,
          );
          writeFileSync(uniq, archive, "utf8");
        } else {
          writeFileSync(archivePath, archive, "utf8");
        }
        result.substantive_archived += 1;
      } catch {
        result.errors += 1;
        continue;
      }
    } else {
      result.empty_removed += 1;
    }

    // Splice the section out of the page body and atomic-rename.
    const newBody = body.slice(0, headStart) + body.slice(blockEnd);
    const data = {
      ...parsed.data,
      last_touched: new Date().toISOString(),
    };
    const tmpPath = `${pagePath}.tmp.${process.pid}.${Date.now()}.${randomBytes(
      4,
    ).toString("hex")}`;
    try {
      writeFileSync(tmpPath, stringifyDoc(data, newBody), "utf8");
      try {
        renameSync(tmpPath, pagePath);
      } catch (err) {
        try {
          unlinkSync(tmpPath);
        } catch {
          // Best-effort cleanup.
        }
        throw err;
      }
      result.blocks_removed += 1;
    } catch {
      result.errors += 1;
    }
  }

  if (result.blocks_removed > 0) {
    appendOpLog(
      "librarian",
      `sweep-legacy-where-we-are: examined=${result.pages_examined} blocks_removed=${result.blocks_removed} substantive_archived=${result.substantive_archived} empty_removed=${result.empty_removed} errors=${result.errors}`,
    );
  }

  return result;
}
