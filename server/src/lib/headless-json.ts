/**
 * Parse the stdout of a `claude --bare -p --output-format json
 * [--json-schema …]` invocation. Returns the structured payload (still
 * `unknown` — caller does the shape check) or `null` if the output is
 * not recoverable.
 *
 * Handles three cases observed in production:
 *
 *  1. The current envelope shape `{ type: "result", result: "<json
 *     string>", … }`. Claude Code's `--output-format json` always wraps
 *     the model response in this envelope; the schema-enforced payload
 *     is in `result` as a string.
 *  2. The model wrapping that inner `result` string in a ```json … ```
 *     fenced markdown block. `--json-schema` does not guarantee
 *     fence-free output in practice (verified against claude 2.1.138).
 *     Without unfencing here, every schema-enforced synth call falls
 *     through to `parse_error` and the librarian fills the page with
 *     deterministic bullets instead of synthesised prose.
 *  3. Older / alternative invocations where the top-level JSON is
 *     already the schema-enforced payload (no envelope). Preserved for
 *     backward-compat with previous CLI shapes.
 */
export function parseHeadlessJsonOutput(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return null;
  let top: unknown;
  try {
    top = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof top !== "object" || top === null) return top;
  if (!("result" in top)) return top;
  const inner = (top as { result: unknown }).result;
  if (typeof inner !== "string") return inner;
  const unfenced = stripCodeFence(inner);
  try {
    return JSON.parse(unfenced);
  } catch {
    return null;
  }
}

function stripCodeFence(s: string): string {
  const t = s.trim();
  const fenced = t.match(/^```[a-zA-Z0-9_-]*\s*\n([\s\S]*?)\n```$/);
  return fenced?.[1]?.trim() ?? t;
}
