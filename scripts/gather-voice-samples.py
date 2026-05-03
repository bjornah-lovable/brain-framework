#!/usr/bin/env python3
"""Extract voice samples from Claude Code session JSONLs.

Two modes:
  --mode all       — every qualifying message (default).
  --mode openings  — only the FIRST qualifying message of each session.
                     Opening prompts are usually composed more
                     deliberately than mid-conversation pings, so they
                     better represent how the author actually writes.

Filter (always applied):
  - non-string content (those are tool_result blocks)
  - <MIN_CHARS chars
  - starts with '/' (slash command)
  - is mostly a bullet list (>50% non-empty lines start with - or *)
  - contains <system-reminder> / <bash-stdout> / etc tags
  - very command-y (one short imperative, no follow-up sentence)
  - tag-only noise

Stratification: up to N samples per source project, total cap M.

Output dir is mode-dependent:
  all       -> ~/brain/raw/voice-samples/
  openings  -> ~/brain/raw/voice-samples-openings/
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator

HOME = Path.home()
PROJECTS = HOME / ".claude" / "projects"

OUT_ALL = HOME / "brain" / "raw" / "voice-samples"
OUT_OPENINGS = HOME / "brain" / "raw" / "voice-samples-openings"

PER_PROJECT_CAP = 10
TOTAL_CAP = 80
MIN_CHARS = 60
MAX_AGE_DAYS = 90


@dataclass
class Sample:
    project: str
    session_id: str
    ts: str
    text: str
    source_jsonl: str

    def key(self) -> str:
        return hashlib.sha256(self.text.encode("utf-8")).hexdigest()[:16]


def looks_command_only(text: str) -> bool:
    """Heuristic: a single short imperative sentence with no flowing follow-up.

    Counts as command-only if (a) only one sentence-ending punctuation
    AND (b) starts with a known imperative-style opener with no follow-up clause.
    """
    sentences = re.split(r"(?<=[.!?])\s+", text.strip())
    nonempty = [s for s in sentences if s.strip()]
    if len(nonempty) <= 1 and len(text) < 120:
        return True
    return False


def is_mostly_bullets(text: str) -> bool:
    lines = [l.strip() for l in text.splitlines() if l.strip()]
    if not lines:
        return True
    bullet = sum(1 for l in lines if l.startswith(("-", "*", "•")))
    return bullet / len(lines) > 0.5


def has_system_tags(text: str) -> bool:
    return bool(
        re.search(
            r"<system-reminder>|<command-name>|<command-message>|<command-args>"
            r"|<bash-stdout>|<bash-stderr>|<local-command-stdout>|<local-command-stderr>"
            r"|<user-prompt-submit-hook>|<user-input-hook>",
            text,
        )
    )


def is_only_tags(text: str) -> bool:
    """True if text is essentially nothing but XML-tag-wrapped tool output."""
    stripped = text.strip()
    # Strip away every <foo>...</foo> block; if what's left is empty, the
    # original is tag-only noise.
    cleaned = re.sub(r"<[^>]+>.*?</[^>]+>", "", stripped, flags=re.DOTALL)
    cleaned = re.sub(r"<[^>]+/>", "", cleaned)
    cleaned = re.sub(r"<[^>]+>", "", cleaned)
    return len(cleaned.strip()) < 30


def starts_with_slash(text: str) -> bool:
    return text.lstrip().startswith("/")


def qualify(text: str) -> bool:
    if len(text) < MIN_CHARS:
        return False
    if starts_with_slash(text):
        return False
    if has_system_tags(text):
        return False
    if is_only_tags(text):
        return False
    if is_mostly_bullets(text):
        return False
    if looks_command_only(text):
        return False
    return True


def walk_jsonls() -> Iterator[Path]:
    cutoff = MAX_AGE_DAYS * 86400
    now = os.path.getmtime(__file__) if False else __import__("time").time()
    for proj in PROJECTS.iterdir():
        if not proj.is_dir():
            continue
        for jl in proj.glob("*.jsonl"):
            try:
                age = now - jl.stat().st_mtime
            except OSError:
                continue
            if age > cutoff:
                continue
            yield jl


def extract_from(jsonl: Path, openings_only: bool) -> Iterator[Sample]:
    project = jsonl.parent.name
    try:
        with jsonl.open("r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if obj.get("type") != "user":
                    continue
                msg = obj.get("message") or {}
                content = msg.get("content")
                if not isinstance(content, str):
                    continue
                if not qualify(content):
                    continue
                yield Sample(
                    project=project,
                    session_id=obj.get("sessionId", "_unknown"),
                    ts=obj.get("timestamp", ""),
                    text=content.strip(),
                    source_jsonl=str(jsonl),
                )
                if openings_only:
                    # First qualifying message only — opening prompts
                    # are usually drafted before the conversation drifts
                    # into informal flow.
                    return
    except OSError:
        return


def main() -> int:
    args = sys.argv[1:]
    mode = "all"
    if "--mode" in args:
        idx = args.index("--mode")
        if idx + 1 < len(args):
            mode = args[idx + 1]
    if mode not in {"all", "openings"}:
        print(f"unknown mode: {mode!r}; expected 'all' or 'openings'", file=sys.stderr)
        return 2

    out = OUT_OPENINGS if mode == "openings" else OUT_ALL
    out.mkdir(parents=True, exist_ok=True)

    seen: set[str] = set()
    by_project: dict[str, list[Sample]] = {}
    total_seen = 0

    for jl in walk_jsonls():
        for s in extract_from(jl, openings_only=(mode == "openings")):
            total_seen += 1
            k = s.key()
            if k in seen:
                continue
            bucket = by_project.setdefault(s.project, [])
            if len(bucket) >= PER_PROJECT_CAP:
                continue
            bucket.append(s)
            seen.add(k)

    samples: list[Sample] = []
    for proj, items in by_project.items():
        items.sort(key=lambda s: len(s.text), reverse=True)
        samples.extend(items)

    samples = samples[:TOTAL_CAP]
    print(
        f"mode={mode}  scanned≈{total_seen}  writing {len(samples)} samples "
        f"from {len(by_project)} projects → {out}"
    )

    for p in out.glob("SAMPLE-*.md"):
        p.unlink()

    for i, s in enumerate(sorted(samples, key=lambda s: (s.project, s.ts)), start=1):
        out_path = out / f"SAMPLE-{i:03d}.md"
        body = (
            f"---\n"
            f"project: {s.project}\n"
            f"session_id: {s.session_id}\n"
            f"timestamp: {s.ts}\n"
            f"source: {s.source_jsonl}\n"
            f"chars: {len(s.text)}\n"
            f"---\n\n"
            f"{s.text}\n"
        )
        out_path.write_text(body, encoding="utf-8")

    return 0


if __name__ == "__main__":
    sys.exit(main())
