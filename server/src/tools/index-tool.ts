import { readFileSync, statSync } from "node:fs";
import { z } from "zod";
import { vaultPaths } from "../lib/vault.js";

export const indexSchema = {
  // No input. Reserved for future filtering by plane.
  _placeholder: z
    .literal("")
    .optional()
    .describe("Reserved; no input required."),
};

export interface IndexResult {
  path: string;
  exists: boolean;
  content?: string;
  last_modified?: string;
}

export function brainIndex(_input: { _placeholder?: string }): IndexResult {
  const v = vaultPaths();
  try {
    const st = statSync(v.index);
    return {
      path: v.index,
      exists: true,
      content: readFileSync(v.index, "utf8"),
      last_modified: st.mtime.toISOString(),
    };
  } catch {
    return { path: v.index, exists: false };
  }
}
