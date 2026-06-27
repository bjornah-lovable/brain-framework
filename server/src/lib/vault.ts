import { homedir } from "node:os";
import { resolve } from "node:path";

const DEFAULT_ROOT = resolve(homedir(), "brain");

export interface VaultPaths {
  readonly root: string;
  readonly profile: string;
  readonly projects: string;
  // `feed` plane retired 2026-05-15; `knowledge/topics/` plus the
  // empty `raw/articles|imports|showboat` subdirs retired 2026-06-27.
  // See SCHEMA.md "Retired planes". `raw/` itself stays — `voice-samples*/`
  // back profile/voice.md.
  readonly raw: string;
  readonly captures: string;
  readonly index: string;
  readonly log: string;
  readonly recent: string;
  readonly schema: string;
  readonly readme: string;
  readonly dot: string;
  readonly config: string;
  readonly db: string;
  readonly state: string;
  readonly logs: string;
  readonly provenance: string;
  readonly needsReview: string;
  readonly processed: string;
  readonly searchRuns: string;
  readonly lock: string;
}

export function vaultRoot(): string {
  return process.env.BRAIN_VAULT_ROOT
    ? resolve(process.env.BRAIN_VAULT_ROOT)
    : DEFAULT_ROOT;
}

export function vaultPaths(): VaultPaths {
  const root = vaultRoot();
  const dot = resolve(root, ".brain");
  return {
    root,
    profile: resolve(root, "profile"),
    projects: resolve(root, "projects"),
    raw: resolve(root, "raw"),
    captures: resolve(root, "captures"),
    index: resolve(root, "index.md"),
    log: resolve(root, "log.md"),
    recent: resolve(root, "recent.md"),
    schema: resolve(root, "SCHEMA.md"),
    readme: resolve(root, "README.md"),
    dot,
    config: resolve(dot, "config.yaml"),
    db: resolve(dot, "db", "brain.db"),
    state: resolve(dot, "state"),
    logs: resolve(dot, "log"),
    provenance: resolve(dot, "provenance"),
    needsReview: resolve(dot, "needs-review"),
    processed: resolve(dot, "processed"),
    searchRuns: resolve(dot, "search", "runs"),
    lock: resolve(dot, "lock"),
  };
}

/**
 * Logical "planes" — the public namespaces inside the vault that an
 * agent might want to read or that the librarian writes to.
 */
export const SYNTHESIZED_PLANES = ["projects"] as const;
export const ALL_PLANES = [
  "profile",
  "projects",
  "raw",
  "captures",
] as const;
export type Plane = (typeof ALL_PLANES)[number];

/**
 * Sacred paths — agents must never write here directly. The PreToolUse
 * hook enforces this for Claude Code's general Write/Edit/MultiEdit
 * tools; the MCP server enforces it for its own brain-* tools.
 */
export function sacredPaths(): readonly string[] {
  const p = vaultPaths();
  return [
    p.profile,
    p.projects,
    p.index,
    p.log,
    p.recent,
    p.provenance,
    resolve(p.dot, "db"),
  ];
}
