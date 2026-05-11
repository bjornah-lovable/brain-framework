import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Candidate } from "./candidates.js";
import { loadConfig } from "../config.js";
import { parseHeadlessJsonOutput } from "../headless-json.js";
import { vaultPaths } from "../vault.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface InvestigatorInput {
  query: string;
  intent?: string;
  scope: string[];
  project_slug?: string;
  freshness?: string;
  max_sources: number;
  candidates: Candidate[];
}

export interface InvestigatorDossier {
  query_interpretation?: string;
  answer: string | null;
  confidence: "high" | "medium" | "low";
  sources: Array<{
    path: string;
    block_id?: string;
    source_type: string;
    last_updated: string;
    snippet: string;
    why_relevant: string;
    provenance_available?: boolean;
  }>;
  suggested_reads: string[];
  open_questions: string[];
}

export interface InvestigatorResult {
  dossier: InvestigatorDossier;
  raw_stdout: string;
  raw_stderr: string;
  duration_ms: number;
  model: string;
  status: "ok" | "parse_error" | "spawn_error" | "timeout" | "nonzero_exit";
  /** SHA-256 of the prompt markdown (= investigator skill version). */
  prompt_sha256: string;
  /** Documented Claude Code flags this run used, for trace replay. */
  flags: string[];
}

const TIMEOUT_MS = 60_000;

function loadAsset(filename: string): string {
  // Source layout:  server/src/skills/<filename>
  // Dist layout:    server/dist/skills/<filename>  (copied at build time)
  const distPath = resolve(__dirname, "..", "skills", filename);
  try {
    return readFileSync(distPath, "utf8");
  } catch {
    const srcPath = resolve(
      __dirname,
      "../../../src/skills/",
      filename,
    );
    return readFileSync(srcPath, "utf8");
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

/**
 * Build the full prompt + schema + sha for a search investigator
 * dispatch, without spawning anything. Used by `brain-search` when
 * routing to a parent-driven Task subagent (default) and by
 * `runInvestigator` when falling back to a headless spawn.
 *
 * The prompt is the skill markdown followed by the JSON payload —
 * exactly the same bytes we would have piped to `claude -p`'s stdin.
 */
export function buildInvestigatorPrompt(input: InvestigatorInput): {
  prompt: string;
  schema: object;
  promptSha: string;
} {
  const skill = loadAsset("brain-search-investigator.md");
  const schemaText = loadAsset("search-dossier.schema.json");
  const promptSha = createHash("sha256").update(skill).digest("hex");
  const payload = JSON.stringify({
    query: input.query,
    intent: input.intent,
    scope: input.scope,
    project_slug: input.project_slug,
    freshness: input.freshness,
    max_sources: input.max_sources,
    candidates: input.candidates,
  });
  const prompt = `${skill}\n\n---\n\nINPUT JSON:\n${payload}\n`;
  const schema = JSON.parse(schemaText) as object;
  return { prompt, schema, promptSha };
}

/**
 * Schema-shape sanity check for a SearchDossier. Reused by
 * brain-search-finalize to validate parent-supplied dossiers.
 */
export function looksLikeDossier(x: unknown): x is InvestigatorDossier {
  if (typeof x !== "object" || x === null) return false;
  const obj = x as Record<string, unknown>;
  if (!Array.isArray(obj["sources"])) return false;
  if (!Array.isArray(obj["suggested_reads"])) return false;
  if (!Array.isArray(obj["open_questions"])) return false;
  if (
    typeof obj["confidence"] !== "string" ||
    !["high", "medium", "low"].includes(obj["confidence"])
  )
    return false;
  return true;
}

/**
 * Run the Sonnet search investigator headlessly.
 *
 * Spawn rules (correctness + cost containment):
 * - argv-only invocation (never shell:true).
 * - Prompt and candidate JSON go via stdin; never on the command line.
 * - --bare skips auto-discovery of hooks/skills/MCP/CLAUDE.md so the
 *   subprocess starts from a clean baseline.
 * - --no-session-persistence prevents this run from showing up in
 *   ~/.claude/projects/ and being treated as a normal session.
 * - --tools "" disables tool access; the investigator works only on
 *   the candidate snippets we hand it.
 * - --max-turns 1 + --max-budget-usd 0.05 cap cost.
 * - --output-format json --json-schema enforces the SearchDossier shape
 *   so we never have to regex-extract JSON from prose.
 * - BRAIN_INTERNAL=1 propagated as defense in depth: capture hooks and
 *   the trajectory indexer skip sessions tagged with this env.
 */
export async function runInvestigator(
  input: InvestigatorInput,
): Promise<InvestigatorResult> {
  const cfg = loadConfig();
  const model = cfg.search.investigator_model;
  const maxBudget = cfg.search.max_budget_usd;
  const claudeBin = process.env.CLAUDE_BIN ?? "claude";

  const { prompt, promptSha } = buildInvestigatorPrompt(input);
  const schemaJson = loadAsset("search-dossier.schema.json");
  const stdin = prompt;

  const args = [
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
    schemaJson,
  ];

  // --bare requires an API key (OAuth and keychain are explicitly
  // skipped). Point claude at our settings-bare.json with apiKeyHelper.
  // If the file isn't present (smoke tests with fake CLAUDE_BIN, fresh
  // install before setup-anthropic-key.sh runs), skip the flag — the
  // spawn will fail at auth time with a clear error.
  const settingsBare = resolve(vaultPaths().dot, "settings-bare.json");
  if (existsSync(settingsBare)) {
    args.push("--settings", settingsBare);
  }

  const start = Date.now();
  const result = await new Promise<{
    stdout: string;
    stderr: string;
    code: number | null;
    timedOut: boolean;
  }>((resolveP) => {
    const child = spawn(claudeBin, args, {
      env: {
        ...process.env,
        BRAIN_INTERNAL: "1",
      },
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

  const meta = {
    raw_stdout: result.stdout,
    raw_stderr: result.stderr,
    duration_ms: duration,
    model,
    prompt_sha256: promptSha,
    flags: args,
  } as const;

  if (result.timedOut) {
    return {
      dossier: failDossier("investigator timed out"),
      ...meta,
      status: "timeout",
    };
  }
  if (result.code !== 0) {
    return {
      dossier: failDossier(
        `investigator exited code=${result.code}; stderr=${result.stderr.slice(0, 200)}`,
      ),
      ...meta,
      status: result.code === -1 ? "spawn_error" : "nonzero_exit",
    };
  }

  const parsed = parseSchemaEnforcedOutput(result.stdout);
  if (!parsed) {
    return {
      dossier: failDossier("investigator returned non-JSON output"),
      ...meta,
      status: "parse_error",
    };
  }
  return { dossier: parsed, ...meta, status: "ok" };
}

function failDossier(msg: string): InvestigatorDossier {
  return {
    answer: null,
    confidence: "low",
    sources: [],
    suggested_reads: [],
    open_questions: [`investigator failed: ${msg}`],
  };
}

/**
 * With --output-format json --json-schema, Claude Code returns a JSON
 * envelope whose `.result` field is the schema-conforming object.
 * If the envelope shape is missing, fall back to parsing the raw
 * stdout as the dossier directly (older CLI versions / edge cases).
 */
function parseSchemaEnforcedOutput(out: string): InvestigatorDossier | null {
  const parsed = parseHeadlessJsonOutput(out);
  return looksLikeDossier(parsed) ? parsed : null;
}

/**
 * Exposed so the search tool can record both the prompt sha and a
 * caller-side digest when writing the trace.
 */
export function investigatorPromptSha256(): string {
  const skill = loadAsset("brain-search-investigator.md");
  return createHash("sha256").update(skill).digest("hex");
}
