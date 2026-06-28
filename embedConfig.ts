// embedConfig.ts — resolves env + config + defaults into one object.
// embed.ts imports this; no other module should.
import type { RagConfig } from "./config.ts";

export interface ResolvedEmbedConfig {
  baseUrl: string;          // always ends in /v1
  model: string;
  apiKey: string;
  dimensions?: number;      // optional; probe fills this in if undefined
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
  // Strip trailing slashes, then append /v1. Works for "http://localhost:11434" and
  // "http://localhost:11434/v1" (idempotent on the second case).
  const baseUrl = raw.replace(/\/+$/, "") + "/v1";
  return {
    baseUrl,
    model: envStr("PI_RAG_EMBED_MODEL")
      ?? (cfg.embeddingModel?.trim() || DEFAULT_MODEL),
    apiKey: envStr("PI_RAG_EMBED_API_KEY")
      ?? (cfg.embeddingApiKey?.trim() || ""),
    dimensions: envNum("PI_RAG_EMBED_DIMENSIONS") ?? cfg.embeddingDimensions,
  };
}
