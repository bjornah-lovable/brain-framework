import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { vaultPaths } from "../lib/vault.js";

export const costSchema = {
  since: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe(
      "Inclusive lower bound (YYYY-MM-DD, vault local time). Defaults to 30 days before `until`.",
    ),
  until: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe("Inclusive upper bound (YYYY-MM-DD). Defaults to today."),
};

export interface DailyCost {
  date: string;
  capture_usd: number;
  synthesis_usd: number;
  total_usd: number;
}

export interface CostResult {
  range: { since: string; until: string };
  capture: {
    runs: number;
    cost_usd: number;
    in_tokens: number;
    out_tokens: number;
    cache_read_tokens: number;
  };
  synthesis: {
    runs: number;
    cost_usd: number;
    in_tokens: number;
    out_tokens: number;
    cache_read_tokens: number;
  };
  total_cost_usd: number;
  by_day: DailyCost[];
}

const FIELD_RE = /(\w+)=([0-9.eE+-]+)/g;

function parseFields(line: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of line.matchAll(FIELD_RE)) {
    const k = m[1];
    const v = Number(m[2]);
    if (k && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

function todayLocal(): string {
  return new Date().toISOString().slice(0, 10);
}

function shiftDate(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function fileDate(name: string, prefix: string): string | null {
  if (!name.startsWith(prefix) || !name.endsWith(".log")) return null;
  const date = name.slice(prefix.length, -4);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  return date;
}

function inRange(date: string, since: string, until: string): boolean {
  return date >= since && date <= until;
}

function readLogLines(path: string): string[] {
  try {
    return readFileSync(path, "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

export function brainCost(input: {
  since?: string;
  until?: string;
}): CostResult {
  const v = vaultPaths();
  const until = input.until ?? todayLocal();
  const since = input.since ?? shiftDate(until, -29);

  const capture = {
    runs: 0,
    cost_usd: 0,
    in_tokens: 0,
    out_tokens: 0,
    cache_read_tokens: 0,
  };
  const synthesis = {
    runs: 0,
    cost_usd: 0,
    in_tokens: 0,
    out_tokens: 0,
    cache_read_tokens: 0,
  };
  const byDay = new Map<string, DailyCost>();

  let files: string[] = [];
  try {
    files = readdirSync(v.logs);
  } catch {
    files = [];
  }

  for (const f of files) {
    const captureDate = fileDate(f, "capture-");
    const libDate = fileDate(f, "librarian-");
    const date = captureDate ?? libDate;
    if (!date || !inRange(date, since, until)) continue;
    const isCapture = captureDate !== null;

    const lines = readLogLines(resolve(v.logs, f));
    for (const line of lines) {
      // The worker line contains `trigger=worker`; the consolidate
      // line contains `consolidate`. Both have cost_usd= when
      // emitted; older lines (pre-instrumentation) may not.
      if (isCapture && !line.includes("trigger=worker")) continue;
      if (!isCapture && !line.includes("consolidate")) continue;

      const fields = parseFields(line);
      if (!("cost_usd" in fields)) continue;

      const cost = fields.cost_usd ?? 0;
      const inTok = fields.in_tokens ?? 0;
      const outTok = fields.out_tokens ?? 0;
      const cacheR = fields.cache_read_tokens ?? 0;

      const bucket = isCapture ? capture : synthesis;
      bucket.runs += 1;
      bucket.cost_usd += cost;
      bucket.in_tokens += inTok;
      bucket.out_tokens += outTok;
      bucket.cache_read_tokens += cacheR;

      const day = byDay.get(date) ?? {
        date,
        capture_usd: 0,
        synthesis_usd: 0,
        total_usd: 0,
      };
      if (isCapture) day.capture_usd += cost;
      else day.synthesis_usd += cost;
      day.total_usd = day.capture_usd + day.synthesis_usd;
      byDay.set(date, day);
    }
  }

  return {
    range: { since, until },
    capture: roundUsd(capture),
    synthesis: roundUsd(synthesis),
    total_cost_usd: round6(capture.cost_usd + synthesis.cost_usd),
    by_day: Array.from(byDay.values())
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((d) => ({
        date: d.date,
        capture_usd: round6(d.capture_usd),
        synthesis_usd: round6(d.synthesis_usd),
        total_usd: round6(d.total_usd),
      })),
  };
}

function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}

function roundUsd<T extends { cost_usd: number }>(t: T): T {
  return { ...t, cost_usd: round6(t.cost_usd) };
}
