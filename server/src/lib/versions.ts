/**
 * Version stamps recorded in search traces and capture metadata so
 * old runs can be reproduced and cached results invalidated when the
 * underlying schema or generator changes.
 *
 * Bump `VAULT_INDEX_VERSION` whenever the SQLite schema or block-ID
 * grammar changes in a way that affects retrieval semantics. Bump
 * `CANDIDATE_GENERATOR_VERSION` whenever the deterministic candidate
 * pipeline changes (FTS query shape, scoring, fallback heuristics).
 *
 * Plain integers, never reset.
 */
export const VAULT_INDEX_VERSION = 2;
export const CANDIDATE_GENERATOR_VERSION = 2;
export const BRAIN_SERVER_VERSION = "0.1.0";
