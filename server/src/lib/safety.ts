import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, sep } from "node:path";
import { vaultPaths, sacredPaths } from "./vault.js";

const HOME = homedir();

/**
 * Absolute paths that brain-ingest must never accept as a source,
 * even if the agent passes them explicitly. These are dirs that
 * commonly hold secrets or auth material.
 */
const FORBIDDEN_INGEST_ROOTS: readonly string[] = [
  resolve(HOME, ".ssh"),
  resolve(HOME, ".aws"),
  resolve(HOME, ".gnupg"),
  resolve(HOME, ".config", "gcloud"),
  resolve(HOME, ".config", "gh"),
  resolve(HOME, ".kube"),
  resolve(HOME, ".docker"),
  resolve(HOME, ".npmrc"),
  resolve(HOME, ".netrc"),
  resolve(HOME, ".claude"),
];

/**
 * Filename patterns that brain-ingest rejects, regardless of location.
 * Matched case-insensitively against the basename and against any
 * segment of the resolved path.
 */
const FORBIDDEN_NAME_PATTERNS: readonly RegExp[] = [
  /^\.env(\..+)?$/i,
  /^\.envrc$/i,
  /^id_[a-z0-9_]+$/i, // id_rsa, id_ed25519, id_ecdsa, …
  /\.pem$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /\.key$/i,
  /\.keystore$/i,
  /^credentials(\..+)?$/i,
  /^service-account.*\.json$/i,
  /^secret(s)?(\..+)?$/i,
];

export class SafetyError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "SafetyError";
    this.code = code;
  }
}

/**
 * Reject a relative path containing any `..` segments before any
 * filesystem call. Catches obvious traversal attempts even when the
 * realpath check would also catch them — defense in depth, and
 * better error messages.
 */
function rejectTraversal(input: string): void {
  const parts = input.split(/[\\/]/);
  for (const part of parts) {
    if (part === "..") {
      throw new SafetyError(
        "PATH_TRAVERSAL",
        `Path contains '..' segment: ${input}`,
      );
    }
  }
}

/**
 * Resolve a vault-relative or absolute path and assert it lies under
 * the vault root after symlink resolution.
 *
 * Used by brain-read, brain-search, brain-read-provenance — anywhere
 * an agent can name a file inside the vault.
 */
export function resolveVaultPath(input: string): string {
  if (typeof input !== "string" || input.length === 0) {
    throw new SafetyError("EMPTY_PATH", "Empty path");
  }
  rejectTraversal(input);
  const v = vaultPaths();
  const candidate = input.startsWith("/") ? input : resolve(v.root, input);

  // realpath if the file exists; otherwise resolve() the parent and
  // check that. We tolerate the file not existing because brain-read
  // wants to return a clean 404 rather than a safety error.
  let resolvedPath: string;
  try {
    resolvedPath = realpathSync(candidate);
  } catch {
    resolvedPath = candidate;
  }

  const rootReal = realpathSync(v.root);
  if (
    resolvedPath !== rootReal &&
    !resolvedPath.startsWith(rootReal + sep)
  ) {
    throw new SafetyError(
      "OUT_OF_VAULT",
      `Path resolves outside vault: ${input} -> ${resolvedPath}`,
    );
  }
  return resolvedPath;
}

/**
 * Same as resolveVaultPath but additionally rejects anything under
 * `.brain/` — the runtime substrate. Agents read content planes;
 * the substrate is for the librarian and operators.
 */
export function resolveContentPath(input: string): string {
  const resolved = resolveVaultPath(input);
  const v = vaultPaths();
  if (resolved === v.dot || resolved.startsWith(v.dot + sep)) {
    throw new SafetyError(
      "DOT_BRAIN_NOT_READABLE",
      `Path is under .brain/ (operator substrate): ${input}`,
    );
  }
  return resolved;
}

/**
 * Validate an external path being ingested. Rejects forbidden roots
 * and forbidden filename patterns. The caller is expected to have
 * realpath()'d the input already.
 */
export function assertIngestSourceSafe(absResolved: string): void {
  for (const root of FORBIDDEN_INGEST_ROOTS) {
    if (absResolved === root || absResolved.startsWith(root + sep)) {
      throw new SafetyError(
        "FORBIDDEN_INGEST_ROOT",
        `Ingest source under protected root (${root}): ${absResolved}`,
      );
    }
  }
  const segments = absResolved.split(sep);
  for (const seg of segments) {
    for (const pat of FORBIDDEN_NAME_PATTERNS) {
      if (pat.test(seg)) {
        throw new SafetyError(
          "FORBIDDEN_FILENAME",
          `Ingest source matches secret-pattern (${pat.source}): ${absResolved}`,
        );
      }
    }
  }
}

/**
 * True if a path resolves under any sacred plane. Used by the MCP
 * server to refuse direct writes to synthesized planes from any
 * tool other than the librarian.
 */
export function isSacred(absResolved: string): boolean {
  const sacred = sacredPaths();
  return sacred.some(
    (s) => absResolved === s || absResolved.startsWith(s + sep),
  );
}

/**
 * Realpath-resolve `input` and assert it lives under the configured
 * source-projects root. The importer reads outside the vault but
 * we still want to refuse paths the user did not explicitly point at.
 *
 * Default root: `~/projects/` (matches Bjorn's actual layout). Override
 * via `BRAIN_PROJECTS_SOURCE` env var; passing `baseDir` here wins
 * over both for explicit caller control (smoke tests).
 */
export function assertSourceProjectsAllowed(
  input: string,
  baseDir?: string,
): string {
  if (typeof input !== "string" || input.length === 0) {
    throw new SafetyError("EMPTY_PATH", "Empty path");
  }
  rejectTraversal(input);
  const candidate = input.startsWith("/") ? input : resolve(input);

  let resolvedPath: string;
  try {
    resolvedPath = realpathSync(candidate);
  } catch {
    resolvedPath = candidate;
  }

  const explicitRoot =
    baseDir ?? process.env.BRAIN_PROJECTS_SOURCE ?? resolve(HOME, "projects");
  let rootReal: string;
  try {
    rootReal = realpathSync(explicitRoot);
  } catch {
    rootReal = explicitRoot;
  }

  if (
    resolvedPath !== rootReal &&
    !resolvedPath.startsWith(rootReal + sep)
  ) {
    throw new SafetyError(
      "OUTSIDE_PROJECTS_SOURCE",
      `Path resolves outside projects-source root: ${input} -> ${resolvedPath}`,
    );
  }
  return resolvedPath;
}

/**
 * Allowed write locations for the MCP server itself (NOT the
 * librarian). The MCP server is permitted to write only to
 * captures/ and raw/imports/.
 */
export function assertMcpWriteAllowed(absResolved: string): void {
  const v = vaultPaths();
  const ok =
    absResolved === v.captures ||
    absResolved.startsWith(v.captures + sep) ||
    absResolved === v.rawImports ||
    absResolved.startsWith(v.rawImports + sep) ||
    absResolved === v.needsReview ||
    absResolved.startsWith(v.needsReview + sep) ||
    absResolved === v.searchRuns ||
    absResolved.startsWith(v.searchRuns + sep) ||
    absResolved === v.logs ||
    absResolved.startsWith(v.logs + sep) ||
    absResolved === v.state ||
    absResolved.startsWith(v.state + sep);
  if (!ok) {
    throw new SafetyError(
      "MCP_WRITE_FORBIDDEN",
      `MCP server may not write here: ${absResolved}`,
    );
  }
}
