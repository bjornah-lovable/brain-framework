import { copyFileSync, mkdirSync, statSync, realpathSync } from "node:fs";
import { resolve, basename } from "node:path";
import { z } from "zod";
import { vaultPaths } from "../lib/vault.js";
import {
  assertIngestSourceSafe,
  assertMcpWriteAllowed,
  SafetyError,
} from "../lib/safety.js";
import { appendOpLog } from "../lib/log.js";

export const ingestSchema = {
  source_path: z
    .string()
    .describe(
      "Absolute path to a file to ingest into raw/imports/. URLs and binary files are rejected in Tier 1.",
    ),
  topic_hint: z
    .string()
    .optional()
    .describe(
      "Optional one-line hint for the librarian about which knowledge topic this belongs to.",
    ),
};

export interface IngestResult {
  source_path: string;
  destination: string;
  bytes: number;
  error?: { code: string; message: string };
}

const ALLOWED_EXTENSIONS = new Set([
  ".md",
  ".markdown",
  ".txt",
  ".html",
  ".json",
  ".yaml",
  ".yml",
]);

export function brainIngest(input: {
  source_path: string;
  topic_hint?: string;
}): IngestResult {
  const v = vaultPaths();

  // Reject relative inputs — caller must provide an absolute path.
  if (!input.source_path.startsWith("/")) {
    return {
      source_path: input.source_path,
      destination: "",
      bytes: 0,
      error: {
        code: "RELATIVE_PATH",
        message: "ingest source_path must be absolute",
      },
    };
  }

  let resolvedSrc: string;
  try {
    resolvedSrc = realpathSync(input.source_path);
  } catch {
    return {
      source_path: input.source_path,
      destination: "",
      bytes: 0,
      error: { code: "NOT_FOUND", message: "source not found" },
    };
  }

  try {
    assertIngestSourceSafe(resolvedSrc);
  } catch (err) {
    if (err instanceof SafetyError) {
      return {
        source_path: input.source_path,
        destination: "",
        bytes: 0,
        error: { code: err.code, message: err.message },
      };
    }
    throw err;
  }

  const lower = resolvedSrc.toLowerCase();
  const ext = lower.slice(lower.lastIndexOf("."));
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    return {
      source_path: input.source_path,
      destination: "",
      bytes: 0,
      error: {
        code: "UNSUPPORTED_TYPE",
        message: `extension ${ext} not allowed in Tier 1 (binary/PDF support is Tier 2)`,
      },
    };
  }

  const st = statSync(resolvedSrc);
  if (!st.isFile()) {
    return {
      source_path: input.source_path,
      destination: "",
      bytes: 0,
      error: { code: "NOT_A_FILE", message: "source is not a regular file" },
    };
  }
  if (st.size > 5 * 1024 * 1024) {
    return {
      source_path: input.source_path,
      destination: "",
      bytes: st.size,
      error: {
        code: "TOO_LARGE",
        message: "source exceeds 5 MiB Tier-1 ingest cap",
      },
    };
  }

  const ts = Math.floor(Date.now() / 1000);
  const safeName = `${ts}-${basename(resolvedSrc).replace(/[^A-Za-z0-9._-]/g, "_")}`;
  const dest = resolve(v.rawImports, safeName);
  assertMcpWriteAllowed(dest);
  mkdirSync(v.rawImports, { recursive: true });
  copyFileSync(resolvedSrc, dest);
  appendOpLog(
    "ingest",
    `queued  src=${resolvedSrc}  dest=${dest}  topic_hint=${input.topic_hint ?? ""}`,
  );
  return { source_path: resolvedSrc, destination: dest, bytes: st.size };
}
