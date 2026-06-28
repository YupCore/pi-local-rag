/**
 * Unit tests for the embedConfig.ts resolver.
 *
 * Per-field precedence: env var > RagConfig field > built-in default.
 * `/v1` auto-append is idempotent (works for both "http://x" and "http://x/v1").
 * `PI_RAG_EMBED_DIMENSIONS` only accepts positive integers — anything else falls
 * through to the config field.
 *
 * We mutate process.env directly. Save/restore wraps every test.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolveEmbedConfig, type ResolvedEmbedConfig } from "../embedConfig.ts";
import { defaultConfig, type RagConfig } from "../config.ts";

const ENV_KEYS = [
  "PI_RAG_EMBED_BASE_URL",
  "PI_RAG_EMBED_MODEL",
  "PI_RAG_EMBED_API_KEY",
  "PI_RAG_EMBED_DIMENSIONS",
] as const;

function snapshotEnv(): Record<string, string | undefined> {
  const snap: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) snap[k] = process.env[k];
  return snap;
}

function restoreEnv(snap: Record<string, string | undefined>) {
  for (const k of ENV_KEYS) {
    if (snap[k] === undefined) delete process.env[k];
    else process.env[k] = snap[k];
  }
}

function clearEnv() {
  for (const k of ENV_KEYS) delete process.env[k];
}

let envSnapshot: Record<string, string | undefined>;

beforeEach(() => {
  envSnapshot = snapshotEnv();
  clearEnv();
});

afterEach(() => {
  restoreEnv(envSnapshot);
});

function cfgWith(overrides: Partial<RagConfig> = {}): RagConfig {
  return { ...defaultConfig(), ...overrides };
}

// ─── Defaults (no env, no config) ────────────────────────────────────────────

describe("resolveEmbedConfig — defaults", () => {
  it("returns llama.cpp defaults when no env or config fields set", () => {
    const r = resolveEmbedConfig(cfgWith());
    expect(r).toEqual<ResolvedEmbedConfig>({
      baseUrl: "http://localhost:8080/v1",
      model: "nomic-embed-text",
      apiKey: "",
      dimensions: undefined,
    });
  });

  it("appends /v1 to a bare base URL", () => {
    expect(resolveEmbedConfig(cfgWith({ embeddingBaseUrl: "http://localhost:11434" })).baseUrl)
      .toBe("http://localhost:11434/v1");
  });

  it("is idempotent on a base URL that already ends with /v1", () => {
    expect(resolveEmbedConfig(cfgWith({ embeddingBaseUrl: "http://localhost:11434/v1" })).baseUrl)
      .toBe("http://localhost:11434/v1");
  });

  it("strips multiple trailing slashes before appending /v1", () => {
    expect(resolveEmbedConfig(cfgWith({ embeddingBaseUrl: "http://x///" })).baseUrl)
      .toBe("http://x/v1");
  });

  it("strips trailing slash on a /v1 URL", () => {
    expect(resolveEmbedConfig(cfgWith({ embeddingBaseUrl: "http://x/v1/" })).baseUrl)
      .toBe("http://x/v1");
  });
});

// ─── Per-field precedence: env > config > default ────────────────────────────

describe("resolveEmbedConfig — precedence", () => {
  it("baseUrl: env wins over config", () => {
    process.env.PI_RAG_EMBED_BASE_URL = "http://env-host:9999";
    const r = resolveEmbedConfig(cfgWith({ embeddingBaseUrl: "http://cfg-host:1111" }));
    expect(r.baseUrl).toBe("http://env-host:9999/v1");
  });

  it("baseUrl: config wins when env unset", () => {
    const r = resolveEmbedConfig(cfgWith({ embeddingBaseUrl: "http://cfg-host:1111" }));
    expect(r.baseUrl).toBe("http://cfg-host:1111/v1");
  });

  it("model: env wins over config", () => {
    process.env.PI_RAG_EMBED_MODEL = "env-model";
    const r = resolveEmbedConfig(cfgWith({ embeddingModel: "cfg-model" }));
    expect(r.model).toBe("env-model");
  });

  it("apiKey: env wins over config", () => {
    process.env.PI_RAG_EMBED_API_KEY = "sk-env";
    const r = resolveEmbedConfig(cfgWith({ embeddingApiKey: "sk-cfg" }));
    expect(r.apiKey).toBe("sk-env");
  });

  it("dimensions: env wins over config", () => {
    process.env.PI_RAG_EMBED_DIMENSIONS = "768";
    const r = resolveEmbedConfig(cfgWith({ embeddingDimensions: 384 }));
    expect(r.dimensions).toBe(768);
  });
});

// ─── PI_RAG_EMBED_DIMENSIONS edge cases ─────────────────────────────────────

describe("resolveEmbedConfig — PI_RAG_EMBED_DIMENSIONS parsing", () => {
  it("accepts a positive integer", () => {
    process.env.PI_RAG_EMBED_DIMENSIONS = "1024";
    expect(resolveEmbedConfig(cfgWith()).dimensions).toBe(1024);
  });

  it("ignores 0 (non-positive)", () => {
    process.env.PI_RAG_EMBED_DIMENSIONS = "0";
    expect(resolveEmbedConfig(cfgWith()).dimensions).toBeUndefined();
  });

  it("ignores negative numbers", () => {
    process.env.PI_RAG_EMBED_DIMENSIONS = "-1";
    expect(resolveEmbedConfig(cfgWith()).dimensions).toBeUndefined();
  });

  it("ignores non-numeric strings", () => {
    process.env.PI_RAG_EMBED_DIMENSIONS = "abc";
    expect(resolveEmbedConfig(cfgWith()).dimensions).toBeUndefined();
  });

  it("ignores empty string", () => {
    process.env.PI_RAG_EMBED_DIMENSIONS = "";
    expect(resolveEmbedConfig(cfgWith()).dimensions).toBeUndefined();
  });

  it("ignores whitespace-only", () => {
    process.env.PI_RAG_EMBED_DIMENSIONS = "   ";
    expect(resolveEmbedConfig(cfgWith()).dimensions).toBeUndefined();
  });

  it("ignores Infinity", () => {
    process.env.PI_RAG_EMBED_DIMENSIONS = "Infinity";
    expect(resolveEmbedConfig(cfgWith()).dimensions).toBeUndefined();
  });

  it("falls through to config hint when env is invalid", () => {
    process.env.PI_RAG_EMBED_DIMENSIONS = "0";
    expect(resolveEmbedConfig(cfgWith({ embeddingDimensions: 384 })).dimensions).toBe(384);
  });

  it("returns undefined when neither env nor config has a valid dim", () => {
    expect(resolveEmbedConfig(cfgWith()).dimensions).toBeUndefined();
  });
});

// ─── Whitespace handling ─────────────────────────────────────────────────────

describe("resolveEmbedConfig — whitespace", () => {
  it("trims whitespace around env vars", () => {
    process.env.PI_RAG_EMBED_BASE_URL = "  http://x:1234  ";
    expect(resolveEmbedConfig(cfgWith()).baseUrl).toBe("http://x:1234/v1");
  });

  it("treats whitespace-only env vars as unset", () => {
    process.env.PI_RAG_EMBED_MODEL = "   ";
    expect(resolveEmbedConfig(cfgWith()).model).toBe("nomic-embed-text");
  });

  it("trims whitespace around config fields", () => {
    const r = resolveEmbedConfig(cfgWith({ embeddingModel: "  cfg-model  " }));
    expect(r.model).toBe("cfg-model");
  });
});

// ─── Auth header downstream behavior ─────────────────────────────────────────

describe("resolveEmbedConfig — apiKey shape", () => {
  it("empty apiKey round-trips as empty string (Authorization header omitted downstream)", () => {
    expect(resolveEmbedConfig(cfgWith()).apiKey).toBe("");
  });

  it("preserves sk- prefix", () => {
    process.env.PI_RAG_EMBED_API_KEY = "sk-abc123";
    expect(resolveEmbedConfig(cfgWith()).apiKey).toBe("sk-abc123");
  });
});