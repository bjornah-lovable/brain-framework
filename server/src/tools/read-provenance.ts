import { readFileSync } from "node:fs";
import { resolve, basename, extname } from "node:path";
import { z } from "zod";
import { resolveContentPath, SafetyError } from "../lib/safety.js";
import { vaultPaths } from "../lib/vault.js";

export const readProvenanceSchema = {
  page: z
    .string()
    .describe(
      "Vault-relative path to a synthesized page, e.g. 'projects/stuck-mitigation.md'.",
    ),
};

export interface ProvenanceResult {
  page: string;
  found: boolean;
  provenance?: unknown;
  error?: { code: string; message: string };
}

/**
 * Provenance sidecars live at .brain/provenance/<plane>/<slug>.json,
 * mirroring the synthesized plane structure.
 */
export function brainReadProvenance(input: {
  page: string;
}): ProvenanceResult {
  const v = vaultPaths();
  let pageAbs: string;
  try {
    pageAbs = resolveContentPath(input.page);
  } catch (err) {
    if (err instanceof SafetyError) {
      return {
        page: input.page,
        found: false,
        error: { code: err.code, message: err.message },
      };
    }
    throw err;
  }

  // Translate page path -> sidecar path. Strip .md, add .json under
  // .brain/provenance.
  const parts = pageAbs.startsWith(v.root + "/")
    ? pageAbs.slice(v.root.length + 1).split("/")
    : pageAbs.split("/");
  if (parts.length < 2) {
    return {
      page: input.page,
      found: false,
      error: {
        code: "BAD_PAGE_PATH",
        message: "Provenance lookup expects <plane>/<file>.md",
      },
    };
  }
  const plane = parts[0]!;
  const file = parts.slice(1).join("/");
  const ext = extname(file);
  const baseNoExt = ext ? file.slice(0, -ext.length) : file;
  const sidecar = resolve(v.provenance, plane, `${baseNoExt}.json`);

  try {
    const raw = readFileSync(sidecar, "utf8");
    return { page: input.page, found: true, provenance: JSON.parse(raw) };
  } catch {
    return {
      page: input.page,
      found: false,
      error: {
        code: "NO_SIDECAR",
        message: `No provenance sidecar at ${basename(sidecar)} (page may be unconsolidated).`,
      },
    };
  }
}
