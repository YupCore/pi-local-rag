import { existsSync, readFileSync, writeFileSync } from "node:fs";
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
}

export function defaultConfig(): RagConfig {
  return {
    ragEnabled: true, ragTopK: 5, ragScoreThreshold: 0.1, ragAlpha: 0.4,
    extraExtensions: [], excludeExtensions: [],
    trackedPaths: [], excludePatterns: [],
  };
}

export function loadConfig(): RagConfig {
  const cfgFile = configFile(getRagDir());
  if (!existsSync(cfgFile)) return defaultConfig();
  try {
    return { ...defaultConfig(), ...JSON.parse(readFileSync(cfgFile, "utf-8")) };
  } catch { return defaultConfig(); }
}

export function saveConfig(config: RagConfig) {
  writeFileSync(configFile(getRagDir()), JSON.stringify(config, null, 2));
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
