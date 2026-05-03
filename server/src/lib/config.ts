import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { vaultPaths } from "./vault.js";

export interface BrainConfig {
  tier: 1 | 2 | 3;
  capture: {
    cadence: "hourly" | "twice_daily" | "daily" | "manual_only";
    hours_local: number[];
    paused: boolean;
    max_bullets_per_capture: number;
  };
  librarian: {
    consolidate_on: "capture" | "scheduled";
    daily_rollover_hour: number;
    lock_timeout_seconds: number;
    staleness_days: number;
    second_agent_review: boolean;
    synthesize_with_llm: boolean;
    synthesizer_model: string;
    synthesizer_max_budget_usd: number;
    delta_classifier_model: string;
    delta_classifier_max_budget_usd: number;
    delta_classifier_max_input_bytes: number;
    import_model: string;
    import_max_budget_usd: number;
    import_max_input_bytes: number;
  };
  mcp: {
    server_name: string;
    read_logs: boolean;
  };
  search: {
    investigator_model: string;
    max_budget_usd: number;
    default_depth: "fast" | "standard" | "deep";
    default_max_sources: number;
    default_max_output_tokens: number;
  };
  enforcement: {
    stage2_evidence_validator: boolean;
    hard_fail_privileged_sources: boolean;
    stop_hook_verification_gates: boolean;
    brain_read_auto_expansion: boolean;
  };
  authoritative_sources: Record<string, unknown>;
}

const DEFAULTS: BrainConfig = {
  tier: 1,
  capture: {
    cadence: "twice_daily",
    hours_local: [12, 17],
    paused: false,
    max_bullets_per_capture: 5,
  },
  librarian: {
    consolidate_on: "capture",
    daily_rollover_hour: 0,
    lock_timeout_seconds: 600,
    staleness_days: 14,
    second_agent_review: false,
    synthesize_with_llm: false,
    synthesizer_model: "claude-sonnet-4-6",
    synthesizer_max_budget_usd: 0.6,
    delta_classifier_model: "claude-sonnet-4-6",
    delta_classifier_max_budget_usd: 0.3,
    delta_classifier_max_input_bytes: 524288,
    import_model: "claude-opus-4-7",
    import_max_budget_usd: 10.0,
    import_max_input_bytes: 1_048_576,
  },
  mcp: {
    server_name: "brain-server",
    read_logs: true,
  },
  search: {
    investigator_model: "claude-sonnet-4-6",
    max_budget_usd: 0.3,
    default_depth: "standard",
    default_max_sources: 6,
    default_max_output_tokens: 1500,
  },
  enforcement: {
    stage2_evidence_validator: false,
    hard_fail_privileged_sources: false,
    stop_hook_verification_gates: false,
    brain_read_auto_expansion: false,
  },
  authoritative_sources: {},
};

let cached: BrainConfig | undefined;

export function loadConfig(): BrainConfig {
  if (cached) return cached;
  const v = vaultPaths();
  let user: Partial<BrainConfig> = {};
  try {
    const raw = readFileSync(v.config, "utf8");
    user = (parseYaml(raw) ?? {}) as Partial<BrainConfig>;
  } catch {
    // Missing config is OK; defaults apply.
  }
  cached = mergeDeep(DEFAULTS, user) as BrainConfig;
  return cached;
}

function mergeDeep<T>(base: T, override: Partial<T>): T {
  if (
    typeof base !== "object" ||
    base === null ||
    typeof override !== "object" ||
    override === null
  ) {
    return (override ?? base) as T;
  }
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(override as Record<string, unknown>)) {
    const baseVal = (base as Record<string, unknown>)[k];
    if (
      v !== null &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      typeof baseVal === "object" &&
      baseVal !== null &&
      !Array.isArray(baseVal)
    ) {
      out[k] = mergeDeep(baseVal, v as Record<string, unknown>);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out as T;
}
