import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { vaultPaths } from "../lib/vault.js";

/**
 * Sidecar provenance — JSON keyed on stable block IDs (v2).
 *
 * Path layout:
 *   ~/brain/.brain/provenance/<plane>/<slug>.json
 */

export interface ProvenanceEntry {
  capture: string;
  session_id: string;
  trigger: string;
  promoted_at: string;
}

export interface ProvenanceFile {
  page: string;
  last_consolidated: string;
  blocks: Record<string, ProvenanceEntry[]>;
}

function sidecarPath(plane: string, slug: string): string {
  const v = vaultPaths();
  return resolve(v.provenance, plane, `${slug}.json`);
}

export function readSidecar(plane: string, slug: string): ProvenanceFile {
  const path = sidecarPath(plane, slug);
  try {
    return JSON.parse(readFileSync(path, "utf8")) as ProvenanceFile;
  } catch {
    return {
      page: `${plane}/${slug}.md`,
      last_consolidated: new Date().toISOString(),
      blocks: {},
    };
  }
}

export function appendSidecar(
  plane: string,
  slug: string,
  blockId: string,
  entry: ProvenanceEntry,
): void {
  const path = sidecarPath(plane, slug);
  mkdirSync(dirname(path), { recursive: true });
  const existing = readSidecar(plane, slug);
  const list = (existing.blocks[blockId] ??= []);
  // De-dup on capture path; promoted_at can vary across runs.
  const already = list.some((e) => e.capture === entry.capture);
  if (!already) list.push(entry);
  existing.last_consolidated = new Date().toISOString();
  writeFileSync(path, JSON.stringify(existing, null, 2) + "\n", "utf8");
}
