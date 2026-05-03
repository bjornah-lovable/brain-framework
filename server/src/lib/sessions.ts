import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { vaultPaths } from "./vault.js";

/**
 * Append-only registry of active sessions that have written to the
 * brain. One JSONL line per brain-capture call. brain-status reads
 * the tail to surface "who is touching what right now."
 *
 * No locks, no leases, no blocking — this is observability substrate
 * for agents to discover overlap, not a coordination protocol.
 */

export interface ActiveSessionEvent {
  session_id: string;
  project_slug: string;
  last_seen_at: string;
  capture_path: string;
  task_id?: string;
  branch?: string;
  worktree?: string;
  agent_id?: string;
  owner?: string;
}

export function recordActiveSession(event: ActiveSessionEvent): void {
  const v = vaultPaths();
  mkdirSync(v.state, { recursive: true });
  const path = resolve(v.state, "active-sessions.jsonl");
  appendFileSync(path, JSON.stringify(event) + "\n", "utf8");
}

export interface ActiveSessionSummary {
  session_id: string;
  project_slug: string;
  last_seen_at: string;
  branch?: string;
  worktree?: string;
}

/**
 * Read the registry tail (default last 200 entries), de-dup by
 * session_id keeping the most recent, return entries seen within the
 * given window (default 24h).
 */
export function recentActiveSessions(opts: {
  windowMs?: number;
  tailLines?: number;
} = {}): ActiveSessionSummary[] {
  const windowMs = opts.windowMs ?? 24 * 60 * 60 * 1000;
  const tailLines = opts.tailLines ?? 200;
  const v = vaultPaths();
  const path = resolve(v.state, "active-sessions.jsonl");
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const lines = raw.trim().split("\n").filter(Boolean);
  const tail = lines.slice(-tailLines);
  const cutoff = Date.now() - windowMs;
  const bySession = new Map<string, ActiveSessionSummary>();
  for (const line of tail) {
    try {
      const e = JSON.parse(line) as ActiveSessionEvent;
      const ts = Date.parse(e.last_seen_at);
      if (Number.isNaN(ts) || ts < cutoff) continue;
      const prev = bySession.get(e.session_id);
      if (prev && Date.parse(prev.last_seen_at) >= ts) continue;
      const entry: ActiveSessionSummary = {
        session_id: e.session_id,
        project_slug: e.project_slug,
        last_seen_at: e.last_seen_at,
      };
      if (e.branch !== undefined) entry.branch = e.branch;
      if (e.worktree !== undefined) entry.worktree = e.worktree;
      bySession.set(e.session_id, entry);
    } catch {
      continue;
    }
  }
  return [...bySession.values()].sort((a, b) =>
    a.last_seen_at < b.last_seen_at ? 1 : -1,
  );
}
