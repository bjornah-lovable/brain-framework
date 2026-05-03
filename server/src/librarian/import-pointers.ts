import { vaultPaths } from "../lib/vault.js";
import { acquireLibrarianLock } from "./lock.js";
import { indexPage } from "./db-write.js";
import {
  discoverProjects,
  existingBrainSlugs,
  prepareImport,
  resolveBrainSlugForImport,
} from "./import.js";
import {
  projectPagePath,
  readPageFrontmatter,
  writeImportedPointer,
} from "./page.js";
import { regenerateIndex } from "./index-page.js";

export interface ImportPointersOptions {
  source: string;
  /** When true, overwrite existing pointer pages (will not run; pointer writer refuses to overwrite). */
  force?: boolean;
  /** Lock wait. */
  waitMs?: number;
}

export interface ImportPointersResult {
  scanned: number;
  created: Array<{ slug: string; path: string }>;
  skipped: Array<{ slug: string; reason: string }>;
  collisions: Array<{ folder: string; reason: string }>;
  errors: Array<{ folder: string; message: string }>;
}

/**
 * Phase-1 importer: walk `source`, write a pointer page per project.
 * Deterministic, $0, idempotent.
 */
export function importPointers(
  opts: ImportPointersOptions,
): ImportPointersResult {
  const v = vaultPaths();
  const lock = acquireLibrarianLock(opts.waitMs !== undefined ? { waitMs: opts.waitMs } : {});
  try {
    const result: ImportPointersResult = {
      scanned: 0,
      created: [],
      skipped: [],
      collisions: [],
      errors: [],
    };
    const projects = discoverProjects(opts.source);
    const knownSlugs = existingBrainSlugs(v.projects);

    for (const project of projects) {
      result.scanned++;
      try {
        const resolved = resolveBrainSlugForImport(
          project,
          knownSlugs,
          readPageFrontmatter,
        );
        if (resolved.alreadyClaims && !opts.force) {
          // Idempotent re-run — page already exists for this folder.
          result.skipped.push({ slug: resolved.slug, reason: "already_present" });
          continue;
        }
        if (resolved.collided && resolved.alreadyClaims) {
          // Dated form also already in use by another folder.
          result.collisions.push({
            folder: project.folderName,
            reason: `slug "${resolved.slug}" already in use`,
          });
          continue;
        }

        const pagePath = projectPagePath(resolved.slug);
        const { sha, frontmatter } = prepareImport(project, resolved.slug);
        const written = writeImportedPointer(resolved.slug, frontmatter);
        if (!written.created) {
          result.skipped.push({ slug: resolved.slug, reason: "already_present" });
          continue;
        }
        knownSlugs.add(resolved.slug);
        indexPage(pagePath, "project");
        result.created.push({ slug: resolved.slug, path: pagePath });
        void sha;
      } catch (err) {
        result.errors.push({
          folder: project.folderName,
          message: (err as Error).message,
        });
      }
    }
    if (result.created.length > 0) {
      try {
        regenerateIndex();
      } catch {
        // Non-fatal.
      }
    }
    return result;
  } finally {
    lock.release();
  }
}
