import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { vaultPaths } from "../lib/vault.js";
import { assertMcpWriteAllowed } from "../lib/safety.js";
import type { CaptureToPromote } from "./synthesize.js";
import type { SectionId, SectionKind } from "./page.js";

export interface PendingSynthesisTask {
  block_id: string;
  project_slug: string;
  section_id: SectionId;
  section_kind: SectionKind;
  capture_paths: string[];
  /** Bodies copied here so apply doesn't depend on captures/ being unchanged. */
  captures: Array<CaptureToPromote & { fname: string; src_abs: string; session_id: string; trigger: string }>;
  /**
   * Set when the task originates from `brain-librarian-plan-imports`.
   * Apply uses this to stamp the page's frontmatter and to skip the
   * "rename capture file to processed/" step (no live capture exists).
   */
  import_source_sha256?: string;
}

export interface PlanFile {
  plan_id: string;
  created_at: string;
  tasks: PendingSynthesisTask[];
}

function plansDir(): string {
  const v = vaultPaths();
  return resolve(v.state, "synthesis-plans");
}

export function savePlan(tasks: PendingSynthesisTask[]): PlanFile {
  const dir = plansDir();
  mkdirSync(dir, { recursive: true });
  // .brain/state/ falls inside the MCP write allowlist (logs writes
  // already use it). Plan files mirror that.
  const planId = newPlanId();
  const path = resolve(dir, `${planId}.json`);
  assertMcpWriteAllowed(path);
  const plan: PlanFile = {
    plan_id: planId,
    created_at: new Date().toISOString(),
    tasks,
  };
  // Atomic write + chmod 600 — plan contains capture body excerpts
  // which may be sensitive.
  const tmp = resolve(dir, `.tmp.${planId}.${randomBytes(3).toString("hex")}`);
  writeFileSync(tmp, JSON.stringify(plan, null, 2), { encoding: "utf8", flag: "wx" });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  return plan;
}

export function loadPlan(planId: string): PlanFile | null {
  if (!/^[A-Za-z0-9]+$/.test(planId)) return null; // path-injection guard
  const path = resolve(plansDir(), `${planId}.json`);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as PlanFile;
  } catch {
    return null;
  }
}

export function deletePlan(planId: string): void {
  if (!/^[A-Za-z0-9]+$/.test(planId)) return;
  const path = resolve(plansDir(), `${planId}.json`);
  try {
    rmSync(path, { force: true });
  } catch {
    // Best-effort.
  }
}

function newPlanId(): string {
  // Sortable + collision-safe; not cryptographic, just unique per run.
  const ts = Date.now().toString(36).toUpperCase();
  const rand = randomBytes(5).toString("hex").toUpperCase();
  return `${ts}${rand}`;
}
