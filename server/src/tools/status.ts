import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { vaultPaths } from "../lib/vault.js";
import { loadConfig } from "../lib/config.js";
import { recentActiveSessions, type ActiveSessionSummary } from "../lib/sessions.js";

export const statusSchema = {
  _placeholder: z.literal("").optional(),
};

export interface StatusResult {
  vault_root: string;
  tier: number;
  capture: {
    cadence: string;
    paused: boolean;
    pending_captures: number;
    needs_review: number;
  };
  librarian: {
    last_run: string | null;
    locked: boolean;
  };
  search: {
    investigator_model: string;
    runs_recorded: number;
  };
  active_sessions_24h: ActiveSessionSummary[];
  enforcement: Record<string, boolean>;
}

function countDir(path: string): number {
  try {
    return readdirSync(path).filter((f) => !f.startsWith(".")).length;
  } catch {
    return 0;
  }
}

function lastLibrarianRun(): string | null {
  const v = vaultPaths();
  try {
    const today = new Date().toISOString().slice(0, 10);
    const candidates = readdirSync(v.logs)
      .filter((f) => f.startsWith("librarian-"))
      .sort()
      .reverse();
    for (const f of candidates) {
      const path = resolve(v.logs, f);
      const lines = readFileSync(path, "utf8").trim().split("\n");
      const last = lines[lines.length - 1];
      if (last) return last.split("  ")[0] ?? today;
    }
  } catch {
    // No log dir yet.
  }
  return null;
}

export function brainStatus(_input: {
  _placeholder?: string;
}): StatusResult {
  const v = vaultPaths();
  const cfg = loadConfig();
  const lockPath = resolve(v.lock, "librarian.lock");
  return {
    vault_root: v.root,
    tier: cfg.tier,
    capture: {
      cadence: cfg.capture.cadence,
      paused:
        cfg.capture.paused || existsSync(resolve(v.state, "paused")),
      pending_captures: countDir(v.captures),
      needs_review: countDir(v.needsReview),
    },
    librarian: {
      last_run: lastLibrarianRun(),
      locked: (() => {
        try {
          return statSync(lockPath).isFile();
        } catch {
          return false;
        }
      })(),
    },
    search: {
      investigator_model: cfg.search.investigator_model,
      runs_recorded: countDir(v.searchRuns),
    },
    active_sessions_24h: recentActiveSessions(),
    enforcement: cfg.enforcement as unknown as Record<string, boolean>,
  };
}
