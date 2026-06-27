#!/usr/bin/env node
/**
 * brain-librarian CLI.
 *
 * Usage:
 *   brain-librarian consolidate [--synthesize|--no-synthesize]
 *   brain-librarian plan-synthesis
 *   brain-librarian apply-synthesis <plan_id> <results-file>
 *   brain-librarian cost [--since YYYY-MM-DD] [--until YYYY-MM-DD]
 *   brain-librarian status
 *   brain-librarian lint     (placeholder)
 *   brain-librarian rollover (placeholder)
 *
 * Holds an exclusive filesystem lock at .brain/lock/librarian.lock for
 * the duration of the run.
 */
import { readFileSync } from "node:fs";
import { acquireLibrarianLock } from "./lock.js";
import { consolidate, headlessAvailable } from "./consolidate.js";
import { vaultPaths } from "../lib/vault.js";
import { brainLibrarianPlanSynthesis } from "../tools/librarian-plan-synthesis.js";
import { brainLibrarianApplySynthesis } from "../tools/librarian-apply-synthesis.js";
import { brainCapture } from "../tools/capture.js";
import { brainCost } from "../tools/cost.js";
import { importPointers } from "./import-pointers.js";
import { brainLibrarianPlanImports } from "../tools/librarian-plan-imports.js";
import { loadConfig } from "../lib/config.js";
import { lint } from "./lint.js";
import { sweepLegacyWhereWeAre } from "./legacy-sweep.js";

function printUsage(): void {
  console.error(
    "usage: brain-librarian <consolidate|plan-synthesis|apply-synthesis|capture|cost|import-pointers|plan-imports|apply-imports|status|lint|sweep-legacy-where-we-are|rollover|config-export> [...]",
  );
}

/**
 * Read JSON from stdin, drain to EOF.
 */
async function readStdinJson(): Promise<unknown> {
  return new Promise((resolveP, rejectP) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      buf += chunk;
    });
    process.stdin.on("end", () => {
      try {
        resolveP(JSON.parse(buf));
      } catch (err) {
        rejectP(err as Error);
      }
    });
    process.stdin.on("error", (err) => rejectP(err));
  });
}

interface Args {
  cmd: string | undefined;
  waitMs: number;
  synthesize: boolean | undefined;
  source: string | undefined;
  status: string[] | undefined;
  slugs: string[] | undefined;
  force: boolean;
  positional: string[];
}

function parseArgs(argv: string[]): Args {
  let cmd: string | undefined;
  let waitMs = 0;
  let synthesize: boolean | undefined;
  let source: string | undefined;
  let status: string[] | undefined;
  let slugs: string[] | undefined;
  let force = false;
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a) continue;
    if (a === "--wait-ms") {
      const n = Number.parseInt(argv[++i] ?? "0", 10);
      if (Number.isFinite(n)) waitMs = n;
    } else if (a === "--synthesize") {
      synthesize = true;
    } else if (a === "--no-synthesize") {
      synthesize = false;
    } else if (a === "--source") {
      source = argv[++i];
    } else if (a === "--status") {
      const v = argv[++i] ?? "";
      status = v.split(",").map((s) => s.trim()).filter(Boolean);
    } else if (a === "--slug") {
      const v = argv[++i] ?? "";
      slugs = v.split(",").map((s) => s.trim()).filter(Boolean);
    } else if (a === "--force") {
      force = true;
    } else if (!cmd) {
      cmd = a;
    } else {
      positional.push(a);
    }
  }
  return { cmd, waitMs, synthesize, source, status, slugs, force, positional };
}

async function main(): Promise<void> {
  const { cmd, waitMs, synthesize, source, status, slugs, force, positional } = parseArgs(process.argv.slice(2));
  if (!cmd) {
    printUsage();
    process.exit(2);
  }

  const v = vaultPaths();
  switch (cmd) {
    case "consolidate": {
      // Synthesize path requires headless eligibility; otherwise the
      // user should use plan-synthesis + apply-synthesis from a CC
      // session via the MCP tools.
      const wantsSynthesize = synthesize ?? false;
      if (wantsSynthesize && !headlessAvailable()) {
        console.error(
          "consolidate --synthesize requires BRAIN_USE_HEADLESS_CLAUDE=1 or " +
            "~/brain/.brain/settings-bare.json. From a Claude Code session, " +
            "use the brain-librarian-plan-synthesis MCP tool instead.",
        );
        process.exit(2);
      }
      const lock = acquireLibrarianLock({ waitMs });
      try {
        const result = await consolidate(
          synthesize !== undefined ? { synthesize } : {},
        );
        console.log(JSON.stringify(result));
      } finally {
        lock.release();
      }
      return;
    }
    case "plan-synthesis": {
      const result = brainLibrarianPlanSynthesis({ wait_ms: waitMs });
      console.log(JSON.stringify(result));
      return;
    }
    case "apply-synthesis": {
      const planId = positional[0];
      const resultsFile = positional[1];
      if (!planId || !resultsFile) {
        console.error("usage: brain-librarian apply-synthesis <plan_id> <results-file>");
        process.exit(2);
      }
      let payload: {
        results: Array<{ block_id: string; output: Record<string, unknown> }>;
        unresolved?: Array<{ block_id: string; reason: string }>;
      };
      try {
        payload = JSON.parse(readFileSync(resultsFile, "utf8"));
      } catch (err) {
        console.error(`could not read results-file: ${(err as Error).message}`);
        process.exit(2);
      }
      const result = brainLibrarianApplySynthesis({
        plan_id: planId,
        results: payload.results ?? [],
        ...(payload.unresolved ? { unresolved: payload.unresolved } : {}),
        wait_ms: waitMs,
      });
      console.log(JSON.stringify(result));
      return;
    }
    case "import-pointers": {
      if (!source) {
        console.error("usage: brain-librarian import-pointers --source <dir> [--force]");
        process.exit(2);
      }
      const result = importPointers({ source, force, waitMs });
      console.log(JSON.stringify(result));
      return;
    }
    case "plan-imports": {
      const planInput: Parameters<typeof brainLibrarianPlanImports>[0] = {
        wait_ms: waitMs,
        force,
      };
      if (source) planInput.source = source;
      if (status) {
        planInput.status_filter = status as ReadonlyArray<
          "active" | "paused" | "done" | "abandoned"
        >;
      }
      if (slugs) planInput.slugs = slugs;
      const result = brainLibrarianPlanImports(planInput);
      console.log(JSON.stringify(result));
      return;
    }
    case "apply-imports": {
      // Alias for apply-synthesis — same code path. Same args.
      const planId = positional[0];
      const resultsFile = positional[1];
      if (!planId || !resultsFile) {
        console.error(
          "usage: brain-librarian apply-imports <plan_id> <results-file>",
        );
        process.exit(2);
      }
      let payload: {
        results: Array<{ block_id: string; output: Record<string, unknown> }>;
        unresolved?: Array<{ block_id: string; reason: string }>;
      };
      try {
        payload = JSON.parse(readFileSync(resultsFile, "utf8"));
      } catch (err) {
        console.error(`could not read results-file: ${(err as Error).message}`);
        process.exit(2);
      }
      const result = brainLibrarianApplySynthesis({
        plan_id: planId,
        results: payload.results ?? [],
        ...(payload.unresolved ? { unresolved: payload.unresolved } : {}),
        wait_ms: waitMs,
      });
      console.log(JSON.stringify(result));
      return;
    }
    case "capture": {
      // CLI write path used by brain-capture.sh after the headless
      // delta classifier returns CAPTURE_CREATED / QUARANTINED.
      // Reads JSON from stdin (the same shape brain-capture's MCP
      // tool accepts), writes the capture file, prints the result.
      const input = (await readStdinJson()) as Parameters<typeof brainCapture>[0];
      const result = brainCapture(input);
      console.log(JSON.stringify(result));
      return;
    }
    case "status": {
      console.log(
        JSON.stringify({
          vault_root: v.root,
          headless_eligible: headlessAvailable(),
          message: "see brain-status MCP tool for full operational state",
        }),
      );
      return;
    }
    case "cost": {
      // Optional --since YYYY-MM-DD --until YYYY-MM-DD.
      const args = process.argv.slice(3);
      let since: string | undefined;
      let until: string | undefined;
      for (let i = 0; i < args.length; i++) {
        if (args[i] === "--since" && args[i + 1]) since = args[++i];
        else if (args[i] === "--until" && args[i + 1]) until = args[++i];
      }
      console.log(JSON.stringify(brainCost({ since, until })));
      return;
    }
    case "config-export": {
      // Print shell-evaluable KEY=VAL lines for bash to source.
      // Used by capture/brain-capture.sh to pick up budgets / models /
      // input-byte caps from .brain/config.yaml without re-implementing
      // YAML parsing in bash.
      const cfg = loadConfig();
      const lines = [
        `BRAIN_DELTA_CLASSIFIER_MODEL=${shellQuote(cfg.librarian.delta_classifier_model)}`,
        `BRAIN_DELTA_CLASSIFIER_MAX_BUDGET_USD=${shellQuote(String(cfg.librarian.delta_classifier_max_budget_usd))}`,
        `BRAIN_DELTA_MAX_INPUT_BYTES=${shellQuote(String(cfg.librarian.delta_classifier_max_input_bytes))}`,
        `BRAIN_IMPORT_MODEL=${shellQuote(cfg.librarian.import_model)}`,
        `BRAIN_IMPORT_MAX_BUDGET_USD=${shellQuote(String(cfg.librarian.import_max_budget_usd))}`,
        `BRAIN_IMPORT_MAX_INPUT_BYTES=${shellQuote(String(cfg.librarian.import_max_input_bytes))}`,
      ];
      console.log(lines.join("\n"));
      return;
    }
    case "lint": {
      const lock = acquireLibrarianLock({ waitMs });
      try {
        const result = lint();
        console.log(JSON.stringify(result));
      } finally {
        lock.release();
      }
      return;
    }
    case "sweep-legacy-where-we-are": {
      const lock = acquireLibrarianLock({ waitMs });
      try {
        const result = sweepLegacyWhereWeAre();
        console.log(JSON.stringify(result));
      } finally {
        lock.release();
      }
      return;
    }
    case "rollover": {
      const lock = acquireLibrarianLock({ waitMs });
      try {
        console.log(
          JSON.stringify({
            command: cmd,
            status: "not_implemented",
            note: "wired in a follow-up phase",
          }),
        );
      } finally {
        lock.release();
      }
      return;
    }
    default:
      printUsage();
      process.exit(2);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});

/**
 * Single-quote-wrap a string for safe shell `eval`. Escapes any
 * embedded single quote.
 */
function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, `'\\''`) + "'";
}
