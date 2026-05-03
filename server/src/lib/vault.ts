import { homedir } from "node:os";
import { resolve } from "node:path";

const DEFAULT_ROOT = resolve(homedir(), "brain");

export interface VaultPaths {
  readonly root: string;
  readonly profile: string;
  readonly projects: string;
  readonly feed: string;
  readonly knowledge: string;
  readonly raw: string;
  readonly rawImports: string;
  readonly rawArticles: string;
  readonly captures: string;
  readonly index: string;
  readonly log: string;
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
    feed: resolve(root, "feed"),
    knowledge: resolve(root, "knowledge"),
    raw: resolve(root, "raw"),
    rawImports: resolve(root, "raw", "imports"),
    rawArticles: resolve(root, "raw", "articles"),
    captures: resolve(root, "captures"),
    index: resolve(root, "index.md"),
    log: resolve(root, "log.md"),
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
export const SYNTHESIZED_PLANES = ["projects", "feed", "knowledge"] as const;
export const ALL_PLANES = [
  "profile",
  "projects",
  "feed",
  "knowledge",
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
    p.feed,
    p.knowledge,
    p.index,
    p.log,
    p.provenance,
    resolve(p.dot, "db"),
  ];
}
