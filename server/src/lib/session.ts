/**
 * Session-id resolution from the running CC process.
 *
 * Phase 0 verified that ~/.claude/sessions/<PID>.json contains the
 * sessionId for any agent-spawned shell. The MCP server is spawned by
 * Claude Code, so process.ppid points to the Claude Code process whose
 * session file we read.
 *
 * Falls back to env BRAIN_SESSION_ID for headless invocations
 * (subagent runs, the launchd capture script, tests).
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

interface SessionFile {
  readonly sessionId?: string;
  readonly cwd?: string;
}

export function resolveSessionId(): string {
  const fromEnv = process.env.BRAIN_SESSION_ID;
  if (fromEnv) return fromEnv;

  const ppid = process.ppid;
  if (!ppid) return "_unknown";
  try {
    const path = resolve(homedir(), ".claude", "sessions", `${ppid}.json`);
    const data = JSON.parse(readFileSync(path, "utf8")) as SessionFile;
    if (data.sessionId) return data.sessionId;
  } catch {
    // Fall through.
  }
  return "_unknown";
}

export function isInternal(): boolean {
  return process.env.BRAIN_INTERNAL === "1";
}
