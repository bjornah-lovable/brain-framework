import Database, { type Database as DB } from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { vaultPaths } from "../lib/vault.js";
import { SCHEMA_SQL } from "./schema.js";

let cached: DB | undefined;

export function openDb(): DB {
  if (cached) return cached;
  const v = vaultPaths();
  mkdirSync(dirname(v.db), { recursive: true });
  const db = new Database(v.db);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  cached = db;
  return db;
}

export function closeDb(): void {
  if (cached) {
    cached.close();
    cached = undefined;
  }
}
