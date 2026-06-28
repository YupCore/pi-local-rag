// embedConfig.ts — resolves env + config + defaults into one object.
// embed.ts imports this; no other module should.
import type { RagConfig } from "./config.ts";

export interface ResolvedEmbedConfig {
  baseUrl: string;          // always ends in /v1
  model: string;
  apiKey: string;
  dimensions?: number;      // optional; probe fills this in if undefined
  concurrency?: number;     // concurrent /v1/embeddings requests during indexing
  batchSize?: number;       // inputs per HTTP call (default 64)
}

const DEFAULT_BASE_URL = "http://localhost:8080";
const DEFAULT_MODEL = "nomic-embed-text";

/** Read a non-empty env var, or undefined. */
function envStr(name: string): string | undefined {
  const v = process.env[name];
  if (v === undefined) return undefined;
  const t = v.trim();
  return t.length > 0 ? t : undefined;
}

/** Read a positive integer env var, or undefined. */
function envNum(name: string): number | undefined {
  const v = envStr(name);
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export function resolveEmbedConfig(cfg: RagConfig): ResolvedEmbedConfig {
  const raw = envStr("PI_RAG_EMBED_BASE_URL")
    ?? (cfg.embeddingBaseUrl?.trim() || DEFAULT_BASE_URL);
  // Strip trailing slashes, then append /v1 unless the URL already ends in it
  // (so "http://x/v1" and "http://x/v1/" both produce "http://x/v1" instead of
  // "http://x/v1/v1").
  let baseUrl = raw.replace(/\/+$/, "");
  if (!/\/v1$/i.test(baseUrl)) baseUrl = baseUrl + "/v1";
  return {
    baseUrl,
    model: envStr("PI_RAG_EMBED_MODEL")
      ?? (cfg.embeddingModel?.trim() || DEFAULT_MODEL),
    apiKey: envStr("PI_RAG_EMBED_API_KEY")
      ?? (cfg.embeddingApiKey?.trim() || ""),
    dimensions: envNum("PI_RAG_EMBED_DIMENSIONS") ?? cfg.embeddingDimensions,
    concurrency: envNum("PI_RAG_EMBED_CONCURRENCY") ?? cfg.embeddingConcurrency,
    batchSize: envNum("PI_RAG_EMBED_BATCH_SIZE") ?? cfg.embeddingBatchSize,
  };
}
