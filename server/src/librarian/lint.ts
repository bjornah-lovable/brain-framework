import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { vaultPaths } from "../lib/vault.js";

/**
 * Deterministic housekeeping pass. No LLM. Sweeps operational state
 * directories that otherwise accumulate forever:
 *
 *   - `.brain/search/runs/*.json` older than `searchRunStaleHours`
 *     with `investigator.status === "pending_parent_dispatch"`. These
 *     are search traces where the parent never finalised — inert
 *     after a day.
 *   - `.brain/state/synthesis-plans/*.json` older than
 *     `synthesisPlanStaleHours`. Same shape: persisted plans the
 *     parent never applied.
 *   - `.brain/state/active-sessions.jsonl` entries older than
 *     `sessionStaleDays`, except for any session whose most-recent
 *     entry is still within the staleness window OR whose sessionId
 *     appears in `~/.claude/sessions/*.json` (a currently-running CC
 *     process). Group-level decision: keep all of a session's
 *     entries, or drop all of them.
 *
 * Reports counters; never throws on benign I/O races.
 */

export interface LintOptions {
  searchRunStaleHours?: number; // default 24
  synthesisPlanStaleHours?: number; // default 24
  sessionStaleDays?: number; // default 30
  /** Override `~/.claude/sessions/` for tests. */
  liveSessionsDir?: string;
}

export interface LintResult {
  swept_search_runs: number;
  swept_synthesis_plans: number;
  trimmed_session_lines: number;
  preserved_session_lines: number;
  active_session_ids: number;
  errors: number;
}

export function lint(opts: LintOptions = {}): LintResult {
  const v = vaultPaths();
  const now = Date.now();
  const searchRunStaleMs =
    (opts.searchRunStaleHours ?? 24) * 60 * 60 * 1000;
  const synthesisPlanStaleMs =
    (opts.synthesisPlanStaleHours ?? 24) * 60 * 60 * 1000;
  const sessionStaleMs =
    (opts.sessionStaleDays ?? 30) * 24 * 60 * 60 * 1000;
  const liveSessionsDir =
    opts.liveSessionsDir ?? resolve(homedir(), ".claude", "sessions");

  let errors = 0;
  const sweptSearchRuns = sweepSearchRuns(
    v.searchRuns,
    now,
    searchRunStaleMs,
    () => errors++,
  );
  const sweptSynthesisPlans = sweepSynthesisPlans(
    resolve(v.state, "synthesis-plans"),
    now,
    synthesisPlanStaleMs,
    () => errors++,
  );
  const sessionResult = trimActiveSessions(
    resolve(v.state, "active-sessions.jsonl"),
    now,
    sessionStaleMs,
    liveSessionsDir,
    () => errors++,
  );

  return {
    swept_search_runs: sweptSearchRuns,
    swept_synthesis_plans: sweptSynthesisPlans,
    trimmed_session_lines: sessionResult.trimmed,
    preserved_session_lines: sessionResult.preserved,
    active_session_ids: sessionResult.activeSessionIds,
    errors,
  };
}

function sweepSearchRuns(
  dir: string,
  now: number,
  staleMs: number,
  onError: () => void,
): number {
  if (!existsSync(dir)) return 0;
  let entries: string[];
  try {
    entries = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    onError();
    return 0;
  }
  let swept = 0;
  for (const fname of entries) {
    const abs = resolve(dir, fname);
    try {
      const st = statSync(abs);
      if (now - st.mtime.getTime() < staleMs) continue;
      const raw = readFileSync(abs, "utf8");
      const parsed = JSON.parse(raw) as { investigator?: { status?: unknown } };
      const status = parsed.investigator?.status;
      if (status !== "pending_parent_dispatch") continue;
      unlinkSync(abs);
      swept += 1;
    } catch {
      onError();
    }
  }
  return swept;
}

function sweepSynthesisPlans(
  dir: string,
  now: number,
  staleMs: number,
  onError: () => void,
): number {
  if (!existsSync(dir)) return 0;
  let entries: string[];
  try {
    entries = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    onError();
    return 0;
  }
  let swept = 0;
  for (const fname of entries) {
    const abs = resolve(dir, fname);
    try {
      const st = statSync(abs);
      if (now - st.mtime.getTime() < staleMs) continue;
      unlinkSync(abs);
      swept += 1;
    } catch {
      onError();
    }
  }
  return swept;
}

interface SessionTrimResult {
  trimmed: number;
  preserved: number;
  activeSessionIds: number;
}

function trimActiveSessions(
  jsonlPath: string,
  now: number,
  staleMs: number,
  liveSessionsDir: string,
  onError: () => void,
): SessionTrimResult {
  if (!existsSync(jsonlPath)) {
    return { trimmed: 0, preserved: 0, activeSessionIds: 0 };
  }
  let raw: string;
  try {
    raw = readFileSync(jsonlPath, "utf8");
  } catch {
    onError();
    return { trimmed: 0, preserved: 0, activeSessionIds: 0 };
  }
  const lines = raw.split("\n").filter((l) => l.length > 0);

  // First pass: per session_id, find the most-recent last_seen_at.
  const lastSeenBySession = new Map<string, number>();
  const parsed: Array<{ raw: string; sessionId: string; lastSeen: number }> = [];
  for (const line of lines) {
    let obj: { session_id?: unknown; last_seen_at?: unknown };
    try {
      obj = JSON.parse(line) as typeof obj;
    } catch {
      // Malformed line — preserve verbatim so we don't silently lose data.
      parsed.push({ raw: line, sessionId: "", lastSeen: now });
      continue;
    }
    const sid = typeof obj.session_id === "string" ? obj.session_id : "";
    const ts =
      typeof obj.last_seen_at === "string" ? Date.parse(obj.last_seen_at) : NaN;
    const lastSeen = Number.isFinite(ts) ? ts : 0;
    parsed.push({ raw: line, sessionId: sid, lastSeen });
    if (!sid) continue;
    const prev = lastSeenBySession.get(sid) ?? 0;
    if (lastSeen > prev) lastSeenBySession.set(sid, lastSeen);
  }

  // Second pass: collect currently-running CC session IDs.
  const liveSessions = readLiveSessionIds(liveSessionsDir, onError);

  // Decide per session_id whether to keep its entries.
  const keepSession = (sid: string): boolean => {
    if (!sid) return true; // malformed-line preserve
    if (liveSessions.has(sid)) return true;
    const ls = lastSeenBySession.get(sid) ?? 0;
    if (now - ls < staleMs) return true;
    return false;
  };

  const kept: string[] = [];
  const activeIds = new Set<string>();
  let trimmed = 0;
  for (const entry of parsed) {
    if (keepSession(entry.sessionId)) {
      kept.push(entry.raw);
      if (entry.sessionId) activeIds.add(entry.sessionId);
    } else {
      trimmed += 1;
    }
  }

  if (trimmed > 0) {
    try {
      writeFileSync(
        jsonlPath,
        kept.length > 0 ? kept.join("\n") + "\n" : "",
        "utf8",
      );
    } catch {
      onError();
    }
  }

  return {
    trimmed,
    preserved: kept.length,
    activeSessionIds: activeIds.size,
  };
}

function readLiveSessionIds(
  dir: string,
  onError: () => void,
): Set<string> {
  const out = new Set<string>();
  if (!existsSync(dir)) return out;
  let entries: string[];
  try {
    entries = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    onError();
    return out;
  }
  for (const fname of entries) {
    try {
      const raw = readFileSync(resolve(dir, fname), "utf8");
      const obj = JSON.parse(raw) as { sessionId?: unknown };
      if (typeof obj.sessionId === "string") out.add(obj.sessionId);
    } catch {
      // Per-file failure is fine; one stale .json doesn't invalidate
      // the whole live-session set.
    }
  }
  return out;
}
