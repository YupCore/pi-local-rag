import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { configFile, getRagDir } from "./store.ts";
import { DEFAULT_TEXT_EXTS } from "./constants.ts";

export interface RagConfig {
  ragEnabled: boolean;
  ragTopK: number;
  ragScoreThreshold: number;
  ragAlpha: number; // 0 = pure vector, 1 = pure BM25
  extraExtensions: string[];   // user-added file extensions (e.g. [".cs", ".tex"])
  excludeExtensions: string[]; // extensions to drop from the default set
  trackedPaths: string[];      // absolute paths previously passed to /rag index
  excludePatterns: string[];   // gitignore-style path patterns
  // Embedding backend (OpenAI-compatible /v1/embeddings endpoint).
  // All optional; unset means use PI_RAG_EMBED_* env or built-in defaults
  // (llama.cpp on localhost:8080, model nomic-embed-text).
  embeddingBaseUrl?: string;
  embeddingModel?: string;
  embeddingApiKey?: string;
  embeddingDimensions?: number;
  embeddingConcurrency?: number;   // concurrent /v1/embeddings requests during indexing (default 3)
}

export function defaultConfig(): RagConfig {
  return {
    ragEnabled: true, ragTopK: 5, ragScoreThreshold: 0.1, ragAlpha: 0.4,
    extraExtensions: [], excludeExtensions: [],
    trackedPaths: [], excludePatterns: [],
  };
}

// Cache config by (mtimeMs, size) of the on-disk file. saveConfig rewrites
// the file (changing mtime) → next read picks up the new version automatically.
// `before_agent_start` reads this every turn, so the cache is the single
// biggest "per-turn" win — no disk read or JSON.parse unless the file changed.
let _cfgCache: { mtimeMs: number; size: number; cfg: RagConfig } | null = null;

export function loadConfig(): RagConfig {
  const cfgFile = configFile(getRagDir());
  let mtimeMs = 0, size = 0;
  try {
    const st = statSync(cfgFile);
    mtimeMs = st.mtimeMs;
    size = st.size;
  } catch {
    return _cfgCache?.cfg ?? defaultConfig();
  }
  if (_cfgCache && _cfgCache.mtimeMs === mtimeMs && _cfgCache.size === size) {
    return _cfgCache.cfg;
  }
  try {
    const cfg = { ...defaultConfig(), ...JSON.parse(readFileSync(cfgFile, "utf-8")) };
    _cfgCache = { mtimeMs, size, cfg };
    return cfg;
  } catch {
    // Malformed JSON: fall back to defaults (don't surface a stale cache
    // — the file just changed to something we can't trust).
    return defaultConfig();
  }
}

export function saveConfig(config: RagConfig) {
  writeFileSync(configFile(getRagDir()), JSON.stringify(config, null, 2));
  // saveConfig always rewrites the file → mtime changes → next loadConfig
  // re-reads. No explicit cache invalidation needed.
}

/** Test-only: drop the loadConfig cache so the next call re-reads the file. */
export function __resetConfigCacheForTests(): void {
  _cfgCache = null;
}

/** Normalize a user-supplied extension to lowercase ".ext" form. */
export function normalizeExt(ext: string): string {
  const trimmed = ext.trim().toLowerCase();
  if (!trimmed) return "";
  return trimmed.startsWith(".") ? trimmed : `.${trimmed}`;
}

/** Build the effective extension allowlist from defaults + user config. */
export function resolveExtensions(config: Pick<RagConfig, "extraExtensions" | "excludeExtensions">): Set<string> {
  const set = new Set(DEFAULT_TEXT_EXTS);
  for (const e of config.extraExtensions) {
    const n = normalizeExt(e);
    if (n) set.add(n);
  }
  for (const e of config.excludeExtensions) {
    const n = normalizeExt(e);
    if (n) set.delete(n);
  }
  return set;
}
