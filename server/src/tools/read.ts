import { readFileSync, statSync } from "node:fs";
import { z } from "zod";
import { resolveContentPath, SafetyError } from "../lib/safety.js";
import { extractBlock } from "../lib/blockId.js";
import { logRead } from "../lib/log.js";
import { loadConfig } from "../lib/config.js";
import { resolveSessionId, isInternal } from "../lib/session.js";
import { brainReadProvenance } from "./read-provenance.js";

export const readSchema = {
  path: z
    .string()
    .describe(
      "Vault-relative or absolute path under ~/brain/. Examples: 'projects/stuck-mitigation.md', 'recent.md', 'index.md'.",
    ),
  block: z
    .string()
    .optional()
    .describe(
      "Optional block ID to extract a single section. Format: <plane>.<slug>.<section>.v<int>.",
    ),
  mode: z
    .enum(["content", "provenance"])
    .optional()
    .describe(
      "'content' (default) returns the page (or block) text. 'provenance' returns the sidecar JSON recording which captures fed which blocks. Provenance ignores `block`.",
    ),
};

export interface ReadResult {
  path: string;
  exists: boolean;
  content?: string;
  size_bytes?: number;
  block?: string;
  mode?: "content" | "provenance";
  provenance?: unknown;
  error?: { code: string; message: string };
}

export function brainRead(input: {
  path: string;
  block?: string;
  mode?: "content" | "provenance";
}): ReadResult {
  if (input.mode === "provenance") {
    const r = brainReadProvenance({ page: input.path });
    const out: ReadResult = {
      path: r.page,
      exists: r.found,
      mode: "provenance",
    };
    if (r.found) out.provenance = r.provenance;
    if (r.error) out.error = r.error;
    return out;
  }

  let resolved: string;
  try {
    resolved = resolveContentPath(input.path);
  } catch (err) {
    if (err instanceof SafetyError) {
      return {
        path: input.path,
        exists: false,
        error: { code: err.code, message: err.message },
      };
    }
    throw err;
  }

  let body: string;
  let size: number;
  try {
    const st = statSync(resolved);
    if (!st.isFile()) {
      return {
        path: resolved,
        exists: false,
        error: { code: "NOT_A_FILE", message: "Path is not a file" },
      };
    }
    size = st.size;
    body = readFileSync(resolved, "utf8");
  } catch {
    return {
      path: resolved,
      exists: false,
      error: { code: "NOT_FOUND", message: "File not found" },
    };
  }

  const cfg = loadConfig();
  if (cfg.mcp.read_logs && !isInternal()) {
    try {
      logRead(resolved, resolveSessionId());
    } catch {
      // Read logs are best-effort; never fail a read because of them.
    }
  }

  if (input.block) {
    const extracted = extractBlock(body, input.block);
    if (extracted == null) {
      return {
        path: resolved,
        exists: true,
        size_bytes: size,
        error: {
          code: "BLOCK_NOT_FOUND",
          message: `Block id not found in page: ${input.block}`,
        },
      };
    }
    return {
      path: resolved,
      exists: true,
      size_bytes: size,
      block: input.block,
      content: extracted,
    };
  }

  return { path: resolved, exists: true, size_bytes: size, content: body };
}
