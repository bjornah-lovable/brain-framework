import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { parseDoc, stringifyDoc } from "../lib/frontmatter.js";
import { vaultPaths } from "../lib/vault.js";
import {
  PROJECT_SECTIONS,
  blockIdComment,
  projectBlockId,
} from "./page.js";

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
  /**
   * Skip the truncated-fallback-bullet sweep across `projects/*.md`. The
   * sweep acquires the librarian lock; tests that don't want lock
   * contention can disable it. Default: enabled.
   */
  truncatedBulletCleanup?: boolean;
}

export interface LintResult {
  swept_search_runs: number;
  swept_synthesis_plans: number;
  trimmed_session_lines: number;
  preserved_session_lines: number;
  active_session_ids: number;
  pages_touched: number;
  truncated_bullets_removed: number;
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

  const bulletSweep =
    opts.truncatedBulletCleanup === false
      ? { pages_touched: 0, bullets_removed: 0 }
      : sweepTruncatedFallbackBullets(() => errors++);

  return {
    swept_search_runs: sweptSearchRuns,
    swept_synthesis_plans: sweptSynthesisPlans,
    trimmed_session_lines: sessionResult.trimmed,
    preserved_session_lines: sessionResult.preserved,
    active_session_ids: sessionResult.activeSessionIds,
    pages_touched: bulletSweep.pages_touched,
    truncated_bullets_removed: bulletSweep.bullets_removed,
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

/**
 * Sweep `projects/*.md` for bullets that look like `appended_fallback`
 * truncations — the symptom the headless synthesizer left behind
 * between 2026-05-06 and 2026-05-11 (claude 2.1.138 `--json-schema`
 * path-vs-inline regression: see commit 345a995 on
 * `bjornah-lovable/brain-framework`).
 *
 * Detector is precision-first by design — this is a sacred-plane
 * delete with no LLM in the loop, so we accept low recall on
 * non-synthesizer truncations to keep false positives near zero.
 *
 * Two stages. Be aware: the **first stage doesn't discriminate
 * happy-path synthesised bullets from buggy fallback bullets** —
 * `appendToProjectPage` (page.ts) emits the same `- <date> — ...`
 * shape for every dated bullet, and synthesised content frequently
 * leads with `**bold**`. The shape filter is a *recall* gate that
 * skips multi-line continuation lines, math `2**3`, hand-written
 * notes that don't start with the date-and-bold prefix, etc. The
 * actual fallback-vs-happy-path discrimination is entirely the
 * symptom heuristics in stage 2 — if a future legitimate bullet
 * satisfies one of those, it will be deleted.
 *
 * Stage 1 — shape filter:
 *     ^- \d{4}-\d{2}-\d{2} — \*\*
 * Dated bullet that opens with bold. Skips hand-written prose,
 * indented continuation lines, math notation.
 *
 * Stage 2 — truncation symptoms (after stage 1):
 *
 *   (a) odd count of unescaped `**` substrings *after stripping
 *       inline code spans* — bold opened and never closed,
 *       e.g. `**v1 ... shown to NOT work in`. Stripping code
 *       prevents `**` inside `\`code\`` from being counted.
 *   (b) closed bold but ends in a dangling word (article /
 *       preposition / conjunction / bare auxiliary) without a `.` `!`
 *       `?` `)` `]` `"` `\`` or `*` on the last non-whitespace char
 *       of the *raw* line, e.g. `**... operative read.** The`.
 *       The dangling-tail check intentionally runs on the raw line
 *       (no code-strip) so a legitimate bullet ending in a code
 *       span like `... see \`scripts/foo\`` doesn't have its last
 *       word synthesised into a false-positive "for" / "in" dangle.
 *
 * On match: bullet is moved to
 * `.brain/needs-review/truncated-bullets-<unix-ts>-<slug>.md`
 * (audit trail — captures aren't touched and the original is still
 * recoverable from `.brain/processed/`) and the page is rewritten
 * without it via tmp+rename so a crash mid-write can never truncate
 * the page.
 *
 * NOTE: the caller must already hold the librarian lock. The CLI
 * `lint` subcommand (`server/src/librarian/cli.ts`) acquires the lock
 * around the entire `lint()` call, so the single-writer-librarian
 * invariant is preserved at that level — this function does not
 * re-acquire it.
 */
export function sweepTruncatedFallbackBullets(
  onError: () => void,
): { pages_touched: number; bullets_removed: number } {
  const v = vaultPaths();
  if (!existsSync(v.projects)) return { pages_touched: 0, bullets_removed: 0 };

  let dirEntries: string[];
  try {
    dirEntries = readdirSync(v.projects);
  } catch {
    onError();
    return { pages_touched: 0, bullets_removed: 0 };
  }

  // Best-effort: sweep any orphan tmp files from a previous crashed
  // rename. Match the deterministic tmp shape emitted below
  // (`<page>.md.tmp.<pid>.<ts>.<8-hex>`) anchored at end-of-name, so a
  // legitimate project page whose slug coincidentally contains
  // `.md.tmp.` is not unlinked.
  for (const fname of dirEntries) {
    if (!ORPHAN_TMP_SHAPE.test(fname)) continue;
    try {
      unlinkSync(resolve(v.projects, fname));
    } catch {
      // Best-effort. Don't onError() — orphan cleanup is hygiene only.
    }
  }

  const entries = dirEntries.filter((f) => f.endsWith(".md"));

  let pagesTouched = 0;
  let bulletsRemoved = 0;

  for (const fname of entries) {
      const slug = fname.replace(/\.md$/, "");
      // Audit-filename component: keep the visible slug intact, but
      // strip anything that isn't safe in a file path. Defence-in-depth
      // against unexpected filenames (e.g. spaces, Unicode) that
      // readdirSync may return verbatim.
      const slugSafe = slug.replace(/[^a-zA-Z0-9._-]/g, "_");
      const pagePath = resolve(v.projects, fname);
      let raw: string;
      try {
        raw = readFileSync(pagePath, "utf8");
      } catch {
        onError();
        continue;
      }
      let parsed: ReturnType<typeof parseDoc>;
      try {
        parsed = parseDoc(raw);
      } catch {
        onError();
        continue;
      }

      const archive: string[] = [];
      let body = parsed.content;
      let pageBulletsRemoved = 0;

      for (const section of PROJECT_SECTIONS) {
        const blockId = projectBlockId(slug, section.id);
        const marker = blockIdComment(blockId);
        const markerIdx = body.indexOf(marker);
        if (markerIdx === -1) continue;
        const blockStart = markerIdx + marker.length;
        let blockEnd = body.indexOf("\n## ", blockStart);
        if (blockEnd === -1) blockEnd = body.length;
        const blockBody = body.slice(blockStart, blockEnd);
        const sweep = filterTruncatedBullets(blockBody);
        if (sweep.removed.length === 0) continue;
        pageBulletsRemoved += sweep.removed.length;
        for (const b of sweep.removed) {
          archive.push(
            `## from projects/${slug}.md  (section: ${section.heading})\n\n${b}`,
          );
        }
        body = body.slice(0, blockStart) + sweep.body + body.slice(blockEnd);
      }

      if (pageBulletsRemoved === 0) continue;

      // Audit FIRST (preservation), page rewrite SECOND, and the page
      // rewrite is tmp+rename so it's atomic — a crash mid-write
      // cannot truncate the page. Worst case is: audit written, page
      // unchanged → next run finds the bullet again, writes another
      // audit, retries the rewrite. Duplicate audit, zero data loss.
      try {
        mkdirSync(v.needsReview, { recursive: true });
        const auditPath = resolve(
          v.needsReview,
          `truncated-bullets-${Date.now()}-${slugSafe}.md`,
        );
        const auditHeader =
          `# Truncated fallback bullets removed from projects/${slug}.md\n\n` +
          `Removed at: ${new Date().toISOString()}\n` +
          `Captures producing these bullets are still in \`.brain/processed/\`.\n\n`;
        writeFileSync(auditPath, auditHeader + archive.join("\n\n"), "utf8");
      } catch {
        onError();
        continue;
      }

      try {
        const data = {
          ...parsed.data,
          last_touched: new Date().toISOString(),
        };
        const tmpPath = `${pagePath}.tmp.${process.pid}.${Date.now()}.${randomBytes(4).toString("hex")}`;
        writeFileSync(tmpPath, stringifyDoc(data, body), "utf8");
        try {
          renameSync(tmpPath, pagePath);
        } catch (err) {
          try {
            unlinkSync(tmpPath);
          } catch {
            // Best-effort cleanup of the orphan tmp.
          }
          throw err;
        }
        pagesTouched += 1;
        bulletsRemoved += pageBulletsRemoved;
      } catch {
        onError();
      }
  }

  return { pages_touched: pagesTouched, bullets_removed: bulletsRemoved };
}

/**
 * Split a block body into kept lines + removed bullet lines.
 * `body` is verbatim text after the `<!-- brain:block ... -->` marker,
 * up to (but not including) the next `## ` heading.
 */
function filterTruncatedBullets(
  body: string,
): { body: string; removed: string[] } {
  const lines = body.split("\n");
  const kept: string[] = [];
  const removed: string[] = [];
  for (const line of lines) {
    if (isTruncatedFallbackBullet(line)) {
      removed.push(line);
    } else {
      kept.push(line);
    }
  }
  return { body: kept.join("\n"), removed };
}

/** Matches the tmp filenames the page-rewrite path below emits.
 *  Anchored so a real `.md` page whose slug happens to contain
 *  `.md.tmp.` is not mistakenly classified as an orphan. */
const ORPHAN_TMP_SHAPE = /\.md\.tmp\.\d+\.\d+\.[0-9a-f]+$/;

const FALLBACK_BULLET_PREFIX = /^- \d{4}-\d{2}-\d{2} — \*\*/;
const DANGLING_TAIL =
  /\b(the|a|an|on|in|of|to|for|with|by|as|via|but|and|or|nor|that|which|than|so|is|was|are|were)\s*$/i;
const TERMINAL_CHARS = new Set([".", "!", "?", ")", "]", '"', "`", "*"]);

/** Classifier for a single page line. Returns true only for the
 *  fallback-bullet shape with truncation symptoms. */
export function isTruncatedFallbackBullet(line: string): boolean {
  if (!FALLBACK_BULLET_PREFIX.test(line)) return false;
  // (a) Bold-count check: strip inline code spans first so `**` inside
  //     backticks (`\`x ** y\``, math notation, doc examples) doesn't
  //     trip an odd count.
  const codeStripped = line.replace(/`[^`]*`/g, "");
  const bold = codeStripped.match(/(?<!\\)\*\*/g) ?? [];
  if (bold.length % 2 === 1) return true;
  // (b) Dangling-tail check: run on the RAW line, not the code-stripped
  //     one. A bullet legitimately ending in a code span like
  //     `... see \`scripts/foo.py\`` is fine — its last char is a
  //     backtick (a TERMINAL char) and we return false. Stripping code
  //     first would expose the word before the code span as the "last
  //     word" and synthesize a dangle that isn't there.
  const rawTrimmed = line.replace(/\s+$/, "");
  const last = rawTrimmed.slice(-1);
  if (TERMINAL_CHARS.has(last)) return false;
  return DANGLING_TAIL.test(rawTrimmed);
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
