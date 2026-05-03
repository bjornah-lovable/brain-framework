import matter from "gray-matter";

export interface ParsedDoc {
  readonly data: Record<string, unknown>;
  readonly content: string;
  readonly raw: string;
}

export function parseDoc(raw: string): ParsedDoc {
  const parsed = matter(raw);
  return {
    data: parsed.data ?? {},
    content: parsed.content,
    raw,
  };
}

export function stringifyDoc(
  data: Record<string, unknown>,
  content: string,
): string {
  return matter.stringify(content, data);
}
