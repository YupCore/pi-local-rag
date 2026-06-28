import { existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

/** Global fallback store. Lazily evaluated so tests can override $HOME. */
export const GLOBAL_RAG_DIR = () => join(homedir(), ".pi", "rag");

/**
 * Resolve the active RAG store directory for the current cwd.
 *
 * 1. `$PI_RAG_DIR` — explicit override, wins over everything.
 * 2. Walk upward from `process.cwd()` looking for an existing `.pi/rag/`,
 *    stopping before `homedir()` so the global store at `~/.pi/rag/` is only
 *    reached as an explicit fallback (not via walk-up).
 * 3. With `createIfMissing`, create `${cwd}/.pi/rag/`.
 * 4. Otherwise, fall back to `${homedir()}/.pi/rag/`.
 */
export function getRagDir(opts: { createIfMissing?: boolean } = {}): string {
  const override = process.env.PI_RAG_DIR;
  if (override) {
    if (!existsSync(override)) mkdirSync(override, { recursive: true });
    return override;
  }
  const home = homedir();
  let dir = process.cwd();
  // Walk-up search, stopping before $HOME so we don't accidentally pick up
  // ~/.pi/rag via the walk (that path is reached only as the explicit
  // fallback below).
  while (true) {
    if (dir === home) break;
    const candidate = join(dir, ".pi", "rag");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }
  if (opts.createIfMissing) {
    const local = join(process.cwd(), ".pi", "rag");
    mkdirSync(local, { recursive: true });
    return local;
  }
  // Fallback: home-dir global. ensureDir handles creation.
  const global = GLOBAL_RAG_DIR();
  ensureDir(global);
  return global;
}

/** SQLite database file. */
export function dbFile(ragDir: string): string { return join(ragDir, "rag.db"); }
export function configFile(ragDir: string): string { return join(ragDir, "config.json"); }

export function ensureDir(ragDir: string) {
  // `recursive: true` is idempotent — no need to existsSync-check first.
  mkdirSync(ragDir, { recursive: true });
}