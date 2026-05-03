import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { vaultPaths } from "../lib/vault.js";
import { parseDoc } from "../lib/frontmatter.js";

/**
 * Deterministic regeneration of `~/brain/index.md`.
 *
 * Walks the synthesized planes (`projects/`, `feed/`, `knowledge/topics/`)
 * and emits a one-line entry per page from frontmatter only. No LLM,
 * no body parsing — the index is derivable from page state alone, so
 * regenerating from scratch each run is cheaper than tracking diffs.
 *
 * Called at the tail of `consolidate()` and `applySynthesisResults()`,
 * so any consolidation that changes a page's frontmatter (`last_touched`,
 * `status`) flows through to the index.
 *
 * Profile pages and `raw/` are intentionally excluded — they aren't
 * librarian-maintained.
 */

interface ProjectEntry {
  slug: string;
  status: string;
  last_touched: string;
  summary?: string;
}

interface FeedEntry {
  date: string;
}

interface TopicEntry {
  topic: string;
  last_updated?: string;
}

export function regenerateIndex(): { path: string; entries: number } {
  const v = vaultPaths();
  const projects = collectProjects(v.projects);
  const feeds = collectFeeds(v.feed);
  const topics = collectTopics(resolve(v.knowledge, "topics"));

  const lines: string[] = [];
  lines.push("# Brain index", "");
  lines.push(
    "One-line directory of synthesized pages. Maintained by the librarian.",
    "",
  );

  lines.push("## Projects", "");
  if (projects.length === 0) {
    lines.push("(none)");
  } else {
    for (const p of projects) {
      const summary = p.summary ? ` — ${p.summary}` : "";
      lines.push(
        `- [${p.slug}](projects/${p.slug}.md) — ${p.status}, last_touched ${formatDate(p.last_touched)}${summary}`,
      );
    }
  }
  lines.push("");

  lines.push("## Feed", "");
  if (feeds.length === 0) {
    lines.push("(none)");
  } else {
    for (const f of feeds) {
      lines.push(`- [${f.date}](feed/${f.date}.md)`);
    }
  }
  lines.push("");

  lines.push("## Knowledge topics", "");
  if (topics.length === 0) {
    lines.push("(none)");
  } else {
    for (const t of topics) {
      const updated = t.last_updated ? ` — updated ${formatDate(t.last_updated)}` : "";
      lines.push(`- [${t.topic}](knowledge/topics/${t.topic}.md)${updated}`);
    }
  }
  lines.push("");

  const body = lines.join("\n");
  writeFileSync(v.index, body, "utf8");
  return {
    path: v.index,
    entries: projects.length + feeds.length + topics.length,
  };
}

function collectProjects(dir: string): ProjectEntry[] {
  if (!existsSync(dir)) return [];
  const out: ProjectEntry[] = [];
  for (const fname of readdirSync(dir)) {
    if (!fname.endsWith(".md")) continue;
    const slug = fname.replace(/\.md$/, "");
    const data = readFrontmatter(resolve(dir, fname));
    if (!data) continue;
    const entry: ProjectEntry = {
      slug: (data["slug"] as string | undefined) ?? slug,
      status: (data["status"] as string | undefined) ?? "unknown",
      last_touched:
        (data["last_touched"] as string | undefined) ??
        (data["created"] as string | undefined) ??
        "",
    };
    const summary = data["summary"];
    if (typeof summary === "string" && summary.trim().length > 0) {
      entry.summary = oneLine(summary);
    }
    out.push(entry);
  }
  return out.sort((a, b) => (b.last_touched || "").localeCompare(a.last_touched || ""));
}

function collectFeeds(dir: string): FeedEntry[] {
  if (!existsSync(dir)) return [];
  const out: FeedEntry[] = [];
  for (const fname of readdirSync(dir)) {
    if (!fname.endsWith(".md")) continue;
    out.push({ date: fname.replace(/\.md$/, "") });
  }
  return out.sort((a, b) => b.date.localeCompare(a.date));
}

function collectTopics(dir: string): TopicEntry[] {
  if (!existsSync(dir)) return [];
  const out: TopicEntry[] = [];
  for (const fname of readdirSync(dir)) {
    if (!fname.endsWith(".md")) continue;
    const topic = fname.replace(/\.md$/, "");
    const data = readFrontmatter(resolve(dir, fname));
    const entry: TopicEntry = {
      topic: (data?.["topic"] as string | undefined) ?? topic,
    };
    const updated = data?.["last_updated"];
    if (typeof updated === "string") entry.last_updated = updated;
    out.push(entry);
  }
  return out.sort((a, b) => a.topic.localeCompare(b.topic));
}

function readFrontmatter(path: string): Record<string, unknown> | null {
  try {
    return parseDoc(readFileSync(path, "utf8")).data;
  } catch {
    return null;
  }
}

function formatDate(iso: string): string {
  if (!iso) return "?";
  return iso.slice(0, 10);
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}
