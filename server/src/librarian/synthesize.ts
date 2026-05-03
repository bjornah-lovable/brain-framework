import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../lib/config.js";
import { vaultPaths } from "../lib/vault.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Generous default — used as a hard wall-clock per-call upper bound.
 * Imports of large legacy projects can take a while in Opus, so the
 * timeout is intentionally lenient.
 */
const TIMEOUT_MS = 5 * 60_000;

export interface CaptureToPromote {
  capture_path: string;
  capture_kind?: string;
  created_at: string;
  body: string;
}

export interface SynthesizeInput {
  project_slug: string;
  block_id: string;
  section_kind:
    | "where_we_are"
    | "blockers"
    | "recent_updates"
    | "artifacts";
  current_block_body: string;
  captures_to_promote: CaptureToPromote[];
  previous_metadata?: {
    summary?: string;
    aliases?: string[];
    entities?: string[];
    search_terms?: string[];
  };
}

export interface SynthesisOutput {
  new_block_body: string;
  summary: string;
  aliases: string[];
  entities: string[];
  search_terms: string[];
  no_op?: boolean;
}

export interface SynthesizeResult {
  ok: boolean;
  output?: SynthesisOutput;
  /** Reason the synthesizer was skipped or failed; deterministic fallback used. */
  reason?:
    | "ok"
    | "disabled"
    | "spawn_error"
    | "timeout"
    | "nonzero_exit"
    | "parse_error"
    | "schema_invalid";
  duration_ms: number;
  prompt_sha256: string;
  flags: string[];
  raw_stdout?: string;
  raw_stderr?: string;
  model: string;
  cost_usd?: number;
  in_tokens?: number;
  out_tokens?: number;
  cache_read_tokens?: number;
}

/**
 * Pull cost + token usage out of a `claude --bare --output-format json`
 * envelope. Tolerates missing fields (e.g. test fakes that only emit
 * the inner result string).
 */
export function extractCostFromEnvelope(stdout: string): {
  cost_usd: number;
  in_tokens: number;
  out_tokens: number;
  cache_read_tokens: number;
} {
  const empty = {
    cost_usd: 0,
    in_tokens: 0,
    out_tokens: 0,
    cache_read_tokens: 0,
  };
  const trimmed = stdout.trim();
  if (!trimmed) return empty;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return empty;
  }
  if (typeof parsed !== "object" || parsed === null) return empty;
  const env = parsed as Record<string, unknown>;
  const cost =
    typeof env.total_cost_usd === "number" ? env.total_cost_usd : 0;
  const usage =
    typeof env.usage === "object" && env.usage !== null
      ? (env.usage as Record<string, unknown>)
      : {};
  return {
    cost_usd: cost,
    in_tokens: typeof usage.input_tokens === "number" ? usage.input_tokens : 0,
    out_tokens:
      typeof usage.output_tokens === "number" ? usage.output_tokens : 0,
    cache_read_tokens:
      typeof usage.cache_read_input_tokens === "number"
        ? usage.cache_read_input_tokens
        : 0,
  };
}

/**
 * Caller indicates which spawn-tier to use: live captures are bounded
 * tightly (Sonnet, $0.60 cap by default), imports of legacy projects
 * use Opus with a much higher budget for thoroughness. The defaults
 * live in `.brain/config.yaml`.
 */
export type SynthesizeMode = "live" | "import";

function loadAsset(filename: string): string {
  const distPath = resolve(__dirname, "..", "skills", filename);
  try {
    return readFileSync(distPath, "utf8");
  } catch {
    return readFileSync(
      resolve(__dirname, "../../../src/skills/", filename),
      "utf8",
    );
  }
}

function loadAssetPath(filename: string): string {
  const distPath = resolve(__dirname, "..", "skills", filename);
  try {
    readFileSync(distPath, "utf8");
    return distPath;
  } catch {
    return resolve(__dirname, "../../../src/skills/", filename);
  }
}

export function synthesisPromptSha256(): string {
  const skill = loadAsset("brain-librarian-synthesis.md");
  return createHash("sha256").update(skill).digest("hex");
}

/**
 * Build the prompt + schema + sha for one librarian-synthesis
 * dispatch. Used by `brain-librarian-plan-synthesis` to hand the
 * payload to a parent CC agent's Task subagent (default), and by
 * `runSynthesizer` itself for the headless fallback.
 */
export function buildSynthesisPrompt(input: SynthesizeInput): {
  prompt: string;
  schema: object;
  promptSha: string;
} {
  const skill = loadAsset("brain-librarian-synthesis.md");
  const schemaText = loadAsset("librarian-synthesis.schema.json");
  const promptSha = createHash("sha256").update(skill).digest("hex");
  const payload = JSON.stringify(input);
  const prompt = `${skill}\n\n---\n\nINPUT JSON:\n${payload}\n`;
  const schema = JSON.parse(schemaText) as object;
  return { prompt, schema, promptSha };
}

/**
 * Full-page import synthesis: produces all four section blocks for
 * one project in a single call. Used by the import path (one Opus
 * spawn per project instead of four). Same caller contract as
 * SynthesisOutput, but four-fold.
 */
export interface FullPageImportInput {
  project_slug: string;
  project_status: "active" | "paused" | "done" | "abandoned";
  block_ids: {
    where_we_are: string;
    blockers: string;
    recent_updates: string;
    artifacts: string;
  };
  current_block_bodies: {
    where_we_are: string;
    blockers: string;
    recent_updates: string;
    artifacts: string;
  };
  previous_metadata?: {
    where_we_are?: SynthesisOutput;
    blockers?: SynthesisOutput;
    recent_updates?: SynthesisOutput;
    artifacts?: SynthesisOutput;
  };
  sources: Array<{
    rel_path: string;
    kind: "report" | "note" | "git" | "meta";
    mtime: string;
    body: string;
  }>;
}

export interface FullPageImportOutput {
  where_we_are: SynthesisOutput;
  blockers: SynthesisOutput;
  recent_updates: SynthesisOutput;
  artifacts: SynthesisOutput;
}

export function buildFullPageImportPrompt(input: FullPageImportInput): {
  prompt: string;
  schema: object;
  promptSha: string;
} {
  const skill = loadAsset("brain-librarian-import-fullpage.md");
  const schemaText = loadAsset("librarian-import-fullpage.schema.json");
  const promptSha = createHash("sha256").update(skill).digest("hex");
  const payload = JSON.stringify(input);
  const prompt = `${skill}\n\n---\n\nINPUT JSON:\n${payload}\n`;
  const schema = JSON.parse(schemaText) as object;
  return { prompt, schema, promptSha };
}

export function looksLikeFullPageImportOutput(
  x: unknown,
): x is FullPageImportOutput {
  if (typeof x !== "object" || x === null) return false;
  const o = x as Record<string, unknown>;
  for (const key of ["where_we_are", "blockers", "recent_updates", "artifacts"]) {
    if (!looksLikeSynthesisOutput(o[key])) return false;
  }
  return true;
}

/**
 * Schema-shape sanity check for a SynthesisOutput. Used by the
 * `brain-librarian-apply-synthesis` MCP tool to validate
 * parent-supplied results before persisting.
 */
export function looksLikeSynthesisOutput(x: unknown): x is SynthesisOutput {
  if (typeof x !== "object" || x === null) return false;
  const o = x as Record<string, unknown>;
  if (typeof o["new_block_body"] !== "string") return false;
  if (typeof o["summary"] !== "string") return false;
  if (!Array.isArray(o["aliases"])) return false;
  if (!Array.isArray(o["entities"])) return false;
  if (!Array.isArray(o["search_terms"])) return false;
  if ((o["aliases"] as unknown[]).some((s) => typeof s !== "string")) return false;
  if ((o["entities"] as unknown[]).some((s) => typeof s !== "string")) return false;
  if ((o["search_terms"] as unknown[]).some((s) => typeof s !== "string")) return false;
  return true;
}

/**
 * Spawn the Sonnet librarian synthesizer headlessly. Same hardening
 * pattern as the search investigator: argv-only, prompt + payload via
 * stdin, --bare to skip auto-discovery, --tools "" to deny filesystem
 * access, --max-turns 1, --max-budget-usd cap, JSON-schema-enforced
 * output. BRAIN_INTERNAL=1 propagated.
 */
export async function runSynthesizer(
  input: SynthesizeInput,
  mode: SynthesizeMode = "live",
): Promise<SynthesizeResult> {
  const cfg = loadConfig();
  const model =
    mode === "import"
      ? cfg.librarian.import_model
      : cfg.librarian.synthesizer_model;
  const maxBudget =
    mode === "import"
      ? cfg.librarian.import_max_budget_usd
      : cfg.librarian.synthesizer_max_budget_usd;
  const claudeBin = process.env.CLAUDE_BIN ?? "claude";

  const { prompt, promptSha } = buildSynthesisPrompt(input);
  const schemaPath = loadAssetPath("librarian-synthesis.schema.json");
  const stdin = prompt;

  const flags = [
    "--bare",
    "-p",
    "--model",
    model,
    "--tools",
    "",
    "--no-session-persistence",
    "--max-turns",
    "1",
    "--max-budget-usd",
    String(maxBudget),
    "--output-format",
    "json",
    "--json-schema",
    schemaPath,
  ];

  // apiKeyHelper auth for --bare. See investigator.ts for the rationale.
  const settingsBare = resolve(vaultPaths().dot, "settings-bare.json");
  if (existsSync(settingsBare)) {
    flags.push("--settings", settingsBare);
  }

  const start = Date.now();
  const result = await new Promise<{
    stdout: string;
    stderr: string;
    code: number | null;
    timedOut: boolean;
  }>((resolveP) => {
    const child = spawn(claudeBin, flags, {
      env: { ...process.env, BRAIN_INTERNAL: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, TIMEOUT_MS);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d: string) => (stdout += d));
    child.stderr.on("data", (d: string) => (stderr += d));
    child.on("error", () => {
      clearTimeout(timer);
      resolveP({ stdout, stderr, code: -1, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveP({ stdout, stderr, code, timedOut });
    });
    child.stdin.end(stdin);
  });
  const duration = Date.now() - start;
  const cost = extractCostFromEnvelope(result.stdout);

  const meta = {
    duration_ms: duration,
    prompt_sha256: promptSha,
    flags,
    raw_stdout: result.stdout,
    raw_stderr: result.stderr,
    model,
    cost_usd: cost.cost_usd,
    in_tokens: cost.in_tokens,
    out_tokens: cost.out_tokens,
    cache_read_tokens: cost.cache_read_tokens,
  } as const;

  if (result.timedOut)
    return { ok: false, reason: "timeout", ...meta };
  if (result.code !== 0)
    return {
      ok: false,
      reason: result.code === -1 ? "spawn_error" : "nonzero_exit",
      ...meta,
    };

  const parsed = parseEnforced(result.stdout);
  if (!parsed) return { ok: false, reason: "parse_error", ...meta };
  if (!validateShape(parsed))
    return { ok: false, reason: "schema_invalid", ...meta };

  return { ok: true, output: parsed, reason: "ok", ...meta };
}

function parseEnforced(out: string): SynthesisOutput | null {
  const trimmed = out.trim();
  if (trimmed.length === 0) return null;
  try {
    const top = JSON.parse(trimmed);
    if (looksLikeSynthesisOutput(top)) return top;
    if (typeof top === "object" && top !== null && "result" in top) {
      const inner = (top as { result: unknown }).result;
      if (typeof inner === "string") {
        const reparsed = JSON.parse(inner);
        if (looksLikeSynthesisOutput(reparsed)) return reparsed;
      } else if (looksLikeSynthesisOutput(inner)) {
        return inner as SynthesisOutput;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Body-shape sanity check beyond looksLikeSynthesisOutput. The
 * --json-schema flag enforces structural validity on the LLM side;
 * this guard protects against shape drift on parse-fallback paths.
 */
function validateShape(o: SynthesisOutput): boolean {
  if (!o.new_block_body.startsWith("## ")) return false;
  if (!o.new_block_body.includes("<!-- brain:block ")) return false;
  return true;
}

export interface FullPageSynthesizeResult {
  ok: boolean;
  output?: FullPageImportOutput;
  reason?: SynthesizeResult["reason"];
  duration_ms: number;
  prompt_sha256: string;
  flags: string[];
  raw_stdout?: string;
  raw_stderr?: string;
  model: string;
  cost_usd?: number;
  in_tokens?: number;
  out_tokens?: number;
  cache_read_tokens?: number;
}

/**
 * Headless full-page import synthesizer. Uses the import-tier model +
 * budget by default (configurable via .brain/config.yaml's
 * `librarian.import_*`). Single Opus call returns all four blocks for
 * one project.
 *
 * Same hardening pattern as runSynthesizer; only differences are the
 * skill+schema and the multi-block output shape.
 */
export async function runFullPageImportSynthesizer(
  input: FullPageImportInput,
): Promise<FullPageSynthesizeResult> {
  const cfg = loadConfig();
  const model = cfg.librarian.import_model;
  const maxBudget = cfg.librarian.import_max_budget_usd;
  const claudeBin = process.env.CLAUDE_BIN ?? "claude";

  const { prompt, promptSha } = buildFullPageImportPrompt(input);
  const schemaPath = loadAssetPath("librarian-import-fullpage.schema.json");

  const flags = [
    "--bare",
    "-p",
    "--model",
    model,
    "--tools",
    "",
    "--no-session-persistence",
    "--max-turns",
    "1",
    "--max-budget-usd",
    String(maxBudget),
    "--output-format",
    "json",
    "--json-schema",
    schemaPath,
  ];

  const settingsBare = resolve(vaultPaths().dot, "settings-bare.json");
  if (existsSync(settingsBare)) {
    flags.push("--settings", settingsBare);
  }

  const start = Date.now();
  const result = await new Promise<{
    stdout: string;
    stderr: string;
    code: number | null;
    timedOut: boolean;
  }>((resolveP) => {
    const child = spawn(claudeBin, flags, {
      env: { ...process.env, BRAIN_INTERNAL: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, TIMEOUT_MS);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d: string) => (stdout += d));
    child.stderr.on("data", (d: string) => (stderr += d));
    child.on("error", () => {
      clearTimeout(timer);
      resolveP({ stdout, stderr, code: -1, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveP({ stdout, stderr, code, timedOut });
    });
    child.stdin.end(prompt);
  });
  const duration = Date.now() - start;
  const cost = extractCostFromEnvelope(result.stdout);

  const meta = {
    duration_ms: duration,
    prompt_sha256: promptSha,
    flags,
    raw_stdout: result.stdout,
    raw_stderr: result.stderr,
    model,
    cost_usd: cost.cost_usd,
    in_tokens: cost.in_tokens,
    out_tokens: cost.out_tokens,
    cache_read_tokens: cost.cache_read_tokens,
  } as const;

  if (result.timedOut) return { ok: false, reason: "timeout", ...meta };
  if (result.code !== 0)
    return {
      ok: false,
      reason: result.code === -1 ? "spawn_error" : "nonzero_exit",
      ...meta,
    };

  const parsed = parseFullPageEnforced(result.stdout);
  if (!parsed) return { ok: false, reason: "parse_error", ...meta };

  return { ok: true, output: parsed, reason: "ok", ...meta };
}

function parseFullPageEnforced(out: string): FullPageImportOutput | null {
  const trimmed = out.trim();
  if (trimmed.length === 0) return null;
  try {
    const top = JSON.parse(trimmed);
    if (looksLikeFullPageImportOutput(top)) return top;
    if (typeof top === "object" && top !== null && "result" in top) {
      const inner = (top as { result: unknown }).result;
      if (typeof inner === "string") {
        const reparsed = JSON.parse(inner);
        if (looksLikeFullPageImportOutput(reparsed)) return reparsed;
      } else if (looksLikeFullPageImportOutput(inner)) {
        return inner as FullPageImportOutput;
      }
    }
    return null;
  } catch {
    return null;
  }
}
