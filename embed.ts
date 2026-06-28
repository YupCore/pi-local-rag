// embed.ts — HTTP client for an OpenAI-compatible /v1/embeddings endpoint.
// Public surface (embed, embedBatch, BATCH_SIZE) is unchanged.

import { createHash } from "node:crypto";
import { loadConfig } from "./config.ts";
import { resolveEmbedConfig } from "./embedConfig.ts";

/** Default batch size for a single /v1/embeddings HTTP call. */
export const BATCH_SIZE = 64;

const HTTP_TIMEOUT_MS = 60_000;
const MAX_RETRIES = 3;
const RETRY_BACKOFF_MS = [500, 1500, 4000] as const; // exponential

export type EmbedErrorCode =
  | "unreachable"
  | "auth"
  | "bad_request"
  | "rate_limited"
  | "model_not_found"
  | "dim_mismatch"
  | "parse"
  | "timeout"
  | "unknown";

export class EmbedError extends Error {
  constructor(
    public readonly code: EmbedErrorCode,
    message: string,
    public readonly status?: number,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "EmbedError";
  }
}

interface EmbeddingItem { index: number; embedding: number[] }
interface EmbeddingResponse { data: EmbeddingItem[]; model?: string }

interface ProbeResult { dim: number }

/** Module-level cache of the server's vector dim, populated by the first probe(). */
let _dim: number | null = null;

// Module-scope cache of resolveEmbedConfig(loadConfig()). Env vars + config
// file don't change mid-session under normal use, so caching saves the ~5 env
// reads + (with config.ts' own mtime cache) the loadConfig disk read per call.
// Indexing fires probe/embedBatch hundreds of times in one session; this is the
// difference between re-resolving on every call and a single hash + lookup.
let _cfgCache: ReturnType<typeof resolveEmbedConfig> | null = null;
function getCfg(): ReturnType<typeof resolveEmbedConfig> {
  return _cfgCache ??= resolveEmbedConfig(loadConfig());
}

/** Yield to the event loop so the TUI can render progress updates. */
const yield_ = () => new Promise<void>(r => setTimeout(r, 0));

/** Test-only: clear cached probe dim and pending probes. Not part of the public API. */
export function __resetProbeForTests(): void {
  _dim = null;
  _probePromise = null;
  _cfgCache = null;
  _embedCache.clear();
}

/** Returns the resolved vector dim: explicit config hint if set, else the
 *  server-probed dim (from the most recent embedBatch/embed call). Throws if
 *  called before any embed has happened and no hint is configured. */
export function getVectorDim(): number {
  const cfg = getCfg();
  if (cfg.dimensions) return cfg.dimensions;
  if (_dim !== null) return _dim;
  throw new EmbedError(
    "dim_mismatch",
    "Vector dim is unknown: no embedding has been performed yet and " +
    "PI_RAG_EMBED_DIMENSIONS / config.embeddingDimensions is unset. " +
    "Call embed() once, or pin the dim explicitly.",
  );
}

// LRU cache for embed(text). Same (model, text) → same embedding (deterministic
// across server calls), so caching is safe. Hit rate is low for distinct
// prompts but useful for repeated queries (auto-inject on retry, similar
// follow-ups). 32 entries ≈ 32 × ~3 KB ≈ 100 KB max.
const EMBED_CACHE_MAX = 32;
const _embedCache = new Map<string, number[]>();
function cacheKey(model: string, text: string): string {
  return model + "\0" + createHash("sha256").update(text).digest("hex").slice(0, 12);
}
function cacheLookup(key: string): number[] | undefined {
  const hit = _embedCache.get(key);
  if (hit !== undefined) {
    // Map preserves insertion order — re-insert to bump LRU position.
    _embedCache.delete(key);
    _embedCache.set(key, hit);
  }
  return hit;
}
function cacheStore(key: string, vec: number[]): void {
  if (_embedCache.size >= EMBED_CACHE_MAX) {
    const oldest = _embedCache.keys().next().value;
    if (oldest !== undefined) _embedCache.delete(oldest);
  }
  _embedCache.set(key, vec);
}

// ─── Probe (one-shot, cached) ────────────────────────────────────────────────

let _probePromise: Promise<ProbeResult> | null = null;

/** Probe the server once: verify reachability + auth + capture the model dim.
 *  Cached after first call. */
async function probe(): Promise<ProbeResult> {
  if (_dim !== null) return { dim: _dim };
  if (_probePromise) return _probePromise;
  _probePromise = (async () => {
    const cfg = getCfg();
    const res = await fetchWithRetry(
      `${cfg.baseUrl}/v1/embeddings`,
      buildRequestInit(cfg, "ping"),
      cfg,
      /* isProbe */ true,
    );
    const body = await parseResponse(res);
    const vec = body.data?.[0]?.embedding;
    if (!Array.isArray(vec) || vec.length === 0) {
      throw new EmbedError(
        "parse",
        `Embedding server returned no embedding for probe input (status ${res.status}).`,
        res.status,
      );
    }
    _dim = vec.length;
    return { dim: _dim };
  })().finally(() => { _probePromise = null; });
  return _probePromise;
}

// ─── fetch with retry/timeout ────────────────────────────────────────────────

function buildRequestInit(
  cfg: ReturnType<typeof resolveEmbedConfig>,
  input: string | string[],
): RequestInit {
  return {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
    },
    body: JSON.stringify({
      input,
      model: cfg.model,
      // OpenAI text-embedding-3-* supports dimension truncation; ignored by llama.cpp / Ollama.
      ...(cfg.dimensions ? { dimensions: cfg.dimensions } : {}),
    }),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  };
}

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  cfg: ReturnType<typeof resolveEmbedConfig>,
  isProbe = false,
): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, init);
      if (res.ok) return res;
      // 4xx (except 408/429) is a client bug — don't retry, surface immediately.
      if (
        res.status >= 400 && res.status < 500
        && res.status !== 408 && res.status !== 429
      ) {
        throw classifyHttpError(res, cfg);
      }
      lastErr = new EmbedError(
        res.status === 429 ? "rate_limited" : "unknown",
        `HTTP ${res.status} ${res.statusText || ""}`.trim(),
        res.status,
      );
    } catch (e) {
      if (e instanceof EmbedError) throw e;
      if (e instanceof DOMException && e.name === "TimeoutError") {
        lastErr = new EmbedError(
          "timeout",
          `Embedding request timed out after ${HTTP_TIMEOUT_MS}ms (${cfg.baseUrl}).`,
          undefined,
          e,
        );
      } else if (e instanceof TypeError) {
        // Node 20 fetch throws TypeError on DNS failure / ECONNREFUSED.
        lastErr = new EmbedError(
          "unreachable",
          `Could not reach embedding server at ${cfg.baseUrl}. ` +
          `Is llama-server / ollama / your backend running? See README § Embeddings backend.`,
          undefined,
          e,
        );
      } else {
        lastErr = e;
      }
    }
    if (attempt < MAX_RETRIES - 1) {
      await new Promise<void>(r => setTimeout(r, RETRY_BACKOFF_MS[attempt]));
    }
  }
  if (lastErr instanceof EmbedError) throw lastErr;
  throw new EmbedError(
    "unreachable",
    `Embedding server unreachable: ${cfg.baseUrl}`,
    undefined,
    lastErr,
  );
}

function classifyHttpError(
  res: Response,
  cfg: ReturnType<typeof resolveEmbedConfig>,
): EmbedError {
  switch (res.status) {
    case 401:
    case 403:
      return new EmbedError(
        "auth",
        `Authentication failed (${res.status}) against ${cfg.baseUrl}. ` +
        `Check PI_RAG_EMBED_API_KEY or your server's auth config.`,
        res.status,
      );
    case 404:
      return new EmbedError(
        "model_not_found",
        `Model "${cfg.model}" not found on ${cfg.baseUrl}. ` +
        `Run \`curl ${cfg.baseUrl}/v1/models\` to list available models.`,
        res.status,
      );
    case 400:
      return new EmbedError(
        "bad_request",
        `Embedding server rejected the request (400). ` +
        `Common causes: model loaded on the server doesn't support embeddings, ` +
        `or input exceeds the model's context window.`,
        res.status,
      );
    default:
      return new EmbedError(
        "unknown",
        `Embedding server returned HTTP ${res.status} ${res.statusText || ""}`.trim(),
        res.status,
      );
  }
}

async function parseResponse(res: Response): Promise<EmbeddingResponse> {
  let body: any;
  try { body = await res.json(); }
  catch (e) {
    throw new EmbedError(
      "parse",
      `Embedding response was not valid JSON (status ${res.status}).`,
      res.status,
      e,
    );
  }
  if (!body || !Array.isArray(body.data)) {
    throw new EmbedError(
      "parse",
      `Embedding response missing "data" array ` +
      `(status ${res.status}, keys: ${body ? Object.keys(body).join(", ") : "null"}).`,
      res.status,
    );
  }
  // Defensive: sort by `index` — some servers (vLLM) return out of order.
  const sorted = (body.data as EmbeddingItem[])
    .map((d, fallback) => ({ d, i: typeof d.index === "number" ? d.index : fallback }))
    .sort((a, b) => a.i - b.i)
    .map(x => x.d);
  for (const item of sorted) {
    if (!Array.isArray(item.embedding)) {
      throw new EmbedError(
        "parse",
        `Embedding response data item missing embedding[] (status ${res.status}).`,
        res.status,
      );
    }
  }
  return { data: sorted, model: body.model };
}

// ─── Public API ──────────────────────────────────────────────────────────────

export async function embed(text: string): Promise<number[]> {
  const cfg = getCfg();
  const key = cacheKey(cfg.model, text);
  const hit = cacheLookup(key);
  if (hit) return hit;
  const [v] = await embedBatch([text]);
  if (v) cacheStore(key, v);
  return v;
}

export async function embedBatch(
  texts: string[],
  onProgress?: (i: number, total: number) => void,
): Promise<number[][]> {
  if (texts.length === 0) return [];
  const cfg = getCfg();
  const { dim: serverDim } = await probe();

  // Dim guard: if the user pinned a dim in config, the server must agree.
  if (cfg.dimensions && cfg.dimensions !== serverDim) {
    throw new EmbedError(
      "dim_mismatch",
      `Configured embeddingDimensions=${cfg.dimensions} but server returned ${serverDim}. ` +
      `Either fix the config or run \`/rag rebuild --force\` after the schema migration.`,
    );
  }

  const url = `${cfg.baseUrl}/v1/embeddings`;
  const results: number[][] = new Array(texts.length);

  for (let start = 0; start < texts.length; start += BATCH_SIZE) {
    const batch = texts.slice(start, start + BATCH_SIZE);
    const res = await fetchWithRetry(url, buildRequestInit(cfg, batch), cfg);
    const body = await parseResponse(res);
    if (body.data.length !== batch.length) {
      throw new EmbedError(
        "parse",
        `Embedding server returned ${body.data.length} vectors for a batch of ${batch.length}.`,
        res.status,
      );
    }
    for (let j = 0; j < batch.length; j++) {
      const vec = body.data[j].embedding;
      if (vec.length !== serverDim) {
        throw new EmbedError(
          "dim_mismatch",
          `Server returned vector of length ${vec.length} but probe dim was ${serverDim}. ` +
          `Run \`/rag rebuild --force\` to re-embed with the new dim.`,
        );
      }
      results[start + j] = vec;
    }

    onProgress?.(Math.min(start + batch.length, texts.length), texts.length);
    await yield_();
  }

  return results;
}
