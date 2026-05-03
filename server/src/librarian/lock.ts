import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { vaultPaths } from "../lib/vault.js";
import { loadConfig } from "../lib/config.js";

/**
 * Filesystem-based lock for the librarian. We avoid `flock(2)` because
 * Node has no portable wrapper; instead use O_EXCL atomic create on a
 * lockfile holding pid + start timestamp. A stale lock (older than the
 * configured timeout) is broken automatically.
 */
export interface LockHandle {
  readonly path: string;
  release(): void;
}

export interface LockOptions {
  readonly waitMs?: number;
}

export function acquireLibrarianLock(opts: LockOptions = {}): LockHandle {
  const cfg = loadConfig();
  const v = vaultPaths();
  const lockDir = v.lock;
  mkdirSync(lockDir, { recursive: true });
  const lockPath = resolve(lockDir, "librarian.lock");
  const timeoutMs = cfg.librarian.lock_timeout_seconds * 1000;
  const waitUntil = Date.now() + (opts.waitMs ?? 0);

  for (;;) {
    try {
      const fd = openSync(lockPath, "wx");
      const payload = JSON.stringify({
        pid: process.pid,
        started_at: new Date().toISOString(),
      });
      writeFileSync(fd, payload);
      closeSync(fd);
      return makeHandle(lockPath);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== "EEXIST") throw err;
      // Lock exists. Is it stale?
      try {
        const st = statSync(lockPath);
        const ageMs = Date.now() - st.mtimeMs;
        if (ageMs > timeoutMs * 2) {
          // Older than 2x the configured runtime cap — break it.
          try {
            unlinkSync(lockPath);
          } catch {
            // Lost a race; loop and retry.
          }
          continue;
        }
        if (Date.now() < waitUntil) {
          // Wait briefly and retry.
          sleepSync(200);
          continue;
        }
      } catch {
        // Lock disappeared between checks; loop and try to create.
        continue;
      }
      // Held by a live process and we're past wait deadline.
      throw new Error(
        `librarian lock held: ${peekHolder(lockPath) ?? "unknown"}`,
      );
    }
  }
}

function makeHandle(path: string): LockHandle {
  let released = false;
  return {
    path,
    release() {
      if (released) return;
      released = true;
      try {
        unlinkSync(path);
      } catch {
        // Best-effort.
      }
    },
  };
}

function peekHolder(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function sleepSync(ms: number): void {
  const end = Date.now() + ms;
  // Busy-wait briefly. Acceptable for this use because the librarian
  // is a one-shot CLI, not a hot loop.
  while (Date.now() < end) {
    // no-op
  }
}
