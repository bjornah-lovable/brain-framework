import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { vaultPaths } from "./vault.js";
import { assertMcpWriteAllowed } from "./safety.js";

function todayLocal(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Append-only operational log line. The MCP server uses this for
 * read logs, capture run summaries, search-run pointers, etc.
 *
 * Path is asserted against the MCP write allowlist before writing.
 */
export function appendOpLog(name: string, line: string): void {
  const v = vaultPaths();
  const path = resolve(v.logs, `${name}-${todayLocal()}.log`);
  assertMcpWriteAllowed(path);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${nowIso()}  ${line}\n`, "utf8");
}

/**
 * Append a one-line entry to the MCP read log. Off if
 * `mcp.read_logs: false` in config — the caller decides.
 */
export function logRead(path: string, sessionId: string | undefined): void {
  appendOpLog(
    "reads",
    `read  session=${sessionId ?? "_"}  path=${path}`,
  );
}
