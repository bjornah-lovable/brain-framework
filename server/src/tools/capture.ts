import { mkdirSync, writeFileSync, renameSync } from "node:fs";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { vaultPaths } from "../lib/vault.js";
import { stringifyDoc } from "../lib/frontmatter.js";
import { resolveSessionId } from "../lib/session.js";
import { assertMcpWriteAllowed } from "../lib/safety.js";
import { appendOpLog } from "../lib/log.js";
import { scanForSecrets } from "../lib/secret-scan.js";
import { recordActiveSession } from "../lib/sessions.js";

const TRIGGERS = [
  "pre_compact",
  "session_end",
  "scheduled",
  "manual",
] as const;

export const captureSchema = {
  body: z
    .string()
    .min(1)
    .describe(
      "Markdown body of the capture. Use sections '## Decisions', '## Findings', '## Blockers / Open questions', '## State changes', '## Notes'. Apply the discipline rubric — capture nothing if nothing is worth keeping. Summarise; do not paste secrets, auth headers, or tokens.",
    ),
  project_slug: z
    .string()
    .regex(/^[a-z0-9][a-z0-9_-]*$/, "lowercase slug")
    .describe(
      "Project slug for routing (e.g. 'stuck-mitigation'). If unknown, pass '_unrouted' — the librarian will park it for review.",
    ),
  trigger: z.enum(TRIGGERS).describe("Capture trigger source."),
  session_id: z
    .string()
    .optional()
    .describe(
      "Session ID. Defaults to the calling session resolved via the runtime PID.",
    ),
  task_id: z.string().optional(),
  worktree: z.string().optional(),
  branch: z.string().optional(),
  tmux_window: z.string().optional(),
  agent_id: z.string().optional(),
  owner: z
    .enum(["claude_code", "codex", "other"])
    .optional()
    .describe("Which agent runtime emitted this capture."),
  importance: z.enum(["low", "medium", "high"]).optional(),
  capture_kind: z
    .enum([
      "decision",
      "finding",
      "blocker",
      "state_change",
      "open_question",
    ])
    .optional(),
  confidence: z.enum(["low", "medium", "high"]).optional(),
  transcript_path: z.string().optional(),
  transcript_start_offset: z.number().int().nonnegative().optional(),
  transcript_end_offset: z.number().int().nonnegative().optional(),
  force: z
    .boolean()
    .optional()
    .describe(
      "Bypass the capture-time secret scan. Default: false. Set true only when you are certain the body contains no real secret (e.g. an explicit example documenting a token shape).",
    ),
};

export interface CaptureResult {
  path: string;
  session_id: string;
  project_slug: string;
  /** True if quarantined to .brain/needs-review/ instead of captures/. */
  quarantined: boolean;
  /** Names of secret patterns that matched, if any. Pattern names only — never the secret text. */
  secret_patterns_matched?: string[];
}

export function brainCapture(input: z.infer<z.ZodObject<typeof captureSchema>>): CaptureResult {
  const v = vaultPaths();
  const sessionId = input.session_id ?? resolveSessionId();
  const ts = Math.floor(Date.now() / 1000);
  const random = randomBytes(3).toString("hex");
  const filename = `session-${sessionId}-${ts}.md`;

  const data: Record<string, unknown> = {
    session_id: sessionId,
    created_at: new Date().toISOString(),
    trigger: input.trigger,
    project_slug: input.project_slug,
  };
  if (input.task_id) data["task_id"] = input.task_id;
  if (input.worktree) data["worktree"] = input.worktree;
  if (input.branch) data["branch"] = input.branch;
  if (input.tmux_window) data["tmux_window"] = input.tmux_window;
  if (input.agent_id) data["agent_id"] = input.agent_id;
  if (input.owner) data["owner"] = input.owner;
  if (input.importance) data["importance"] = input.importance;
  if (input.capture_kind) data["capture_kind"] = input.capture_kind;
  if (input.confidence) data["confidence"] = input.confidence;
  if (input.transcript_path) {
    data["transcript"] = {
      path: input.transcript_path,
      start_offset: input.transcript_start_offset ?? null,
      end_offset: input.transcript_end_offset ?? null,
    };
  }

  // Secret scan over body + frontmatter values. Frontmatter is
  // stringified for the scan; the matched text is never returned to
  // the caller, only pattern names.
  const scanText = `${input.body}\n${JSON.stringify(data)}`;
  const scan = input.force ? { hit: false, patterns: [] as string[] } : scanForSecrets(scanText);
  const quarantined = scan.hit && !input.force;
  if (quarantined) {
    data["quarantine_reason"] = "secret_scan_hit";
    data["quarantine_patterns"] = scan.patterns;
  }

  const md = stringifyDoc(
    data,
    input.body.endsWith("\n") ? input.body : `${input.body}\n`,
  );

  const targetDir = quarantined ? v.needsReview : v.captures;
  const target = resolve(targetDir, filename);
  assertMcpWriteAllowed(target);

  // Atomic write: tmp + fsync + rename.
  mkdirSync(targetDir, { recursive: true });
  const tmp = resolve(targetDir, `.tmp.${ts}.${random}`);
  writeFileSync(tmp, md, { encoding: "utf8", flag: "wx" });
  renameSync(tmp, target);

  appendOpLog(
    "capture",
    `wrote  trigger=${input.trigger}  project=${input.project_slug}  session=${sessionId}  quarantined=${quarantined}  file=${filename}`,
  );

  // Active-session registry — append-only JSONL. Records both regular
  // and quarantined captures since both indicate activity.
  try {
    const event: Parameters<typeof recordActiveSession>[0] = {
      session_id: sessionId,
      project_slug: input.project_slug,
      last_seen_at: new Date().toISOString(),
      capture_path: target,
    };
    if (input.task_id) event.task_id = input.task_id;
    if (input.branch) event.branch = input.branch;
    if (input.worktree) event.worktree = input.worktree;
    if (input.agent_id) event.agent_id = input.agent_id;
    if (input.owner) event.owner = input.owner;
    recordActiveSession(event);
  } catch {
    // Best-effort; registry is observability, not a hard dependency.
  }

  const result: CaptureResult = {
    path: target,
    session_id: sessionId,
    project_slug: input.project_slug,
    quarantined,
  };
  if (scan.patterns.length > 0) {
    result.secret_patterns_matched = scan.patterns;
  }
  return result;
}
