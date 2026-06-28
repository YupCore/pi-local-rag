/**
 * Unit tests for the embed.ts HTTP client.
 *
 * Stubs globalThis.fetch so we can exercise the retry / auth / parse /
 * dim-mismatch paths without a real embedding server. The default fetch
 * stub returns 384-dim vectors for /v1/embeddings; specific tests override
 * it to inject errors, custom dims, etc.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, vi } from "vitest";
import { EmbedError, embed, embedBatch, __resetProbeForTests } from "../embed.ts";

const DIM = 384;
const originalFetch = globalThis.fetch;
let fetchImpl: typeof fetch;

beforeAll(() => {
  process.env.PI_RAG_EMBED_BASE_URL = "http://test-embed";
  process.env.PI_RAG_EMBED_MODEL = "test-embed";
  process.env.PI_RAG_EMBED_API_KEY = "";
  process.env.PI_RAG_EMBED_DIMENSIONS = String(DIM);
});

beforeEach(() => {
  __resetProbeForTests();
  fetchImpl = defaultFetch(DIM);
  globalThis.fetch = ((...args: Parameters<typeof fetch>) =>
    fetchImpl(...args)) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  fetchImpl = defaultFetch(DIM);
  __resetProbeForTests();
});

function defaultFetch(dim: number): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (!url.endsWith("/v1/embeddings")) {
      return new Response("not found", { status: 404 });
    }
    const body = JSON.parse(String(init?.body ?? "{}")) as { input: string | string[] };
    const inputs = Array.isArray(body.input) ? body.input : [body.input];
    return new Response(JSON.stringify({
      object: "list",
      model: "test-embed",
      data: inputs.map((text, index) => ({
        object: "embedding",
        index,
        embedding: Array.from({ length: dim }, (_, k) => Math.sin(text.length + k) * 0.1),
      })),
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("embed HTTP client", () => {
  // ─── Headers ───────────────────────────────────────────────────────────────

  it("sends Authorization: Bearer <key> when PI_RAG_EMBED_API_KEY is set", async () => {
    process.env.PI_RAG_EMBED_API_KEY = "sk-test-1234";
    let captured: RequestInit | undefined;
    fetchImpl = (async (_input, init) => {
      captured = init;
      return defaultFetch(DIM)("http://test-embed/v1/embeddings", init);
    }) as typeof fetch;

    await embedBatch(["hi"]);
    const headers = captured?.headers as Record<string, string> | undefined;
    expect(headers?.["Authorization"]).toBe("Bearer sk-test-1234");
    delete process.env.PI_RAG_EMBED_API_KEY;
  });

  it("omits Authorization header when no API key is configured", async () => {
    process.env.PI_RAG_EMBED_API_KEY = "";
    let captured: RequestInit | undefined;
    fetchImpl = (async (_input, init) => {
      captured = init;
      return defaultFetch(DIM)("http://test-embed/v1/embeddings", init);
    }) as typeof fetch;

    await embedBatch(["hi"]);
    const headers = captured?.headers as Record<string, string> | undefined;
    expect(headers?.["Authorization"]).toBeUndefined();
  });

  // ─── Input handling ────────────────────────────────────────────────────────

  it("empty input array → empty result, no fetch", async () => {
    const spy = vi.fn(async () => new Response("{}", { status: 200 }));
    fetchImpl = spy as unknown as typeof fetch;
    const result = await embedBatch([]);
    expect(result).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it("single-string input is wrapped into an array on the wire", async () => {
    let capturedBody: any;
    fetchImpl = (async (_input, init) => {
      capturedBody = JSON.parse(String(init?.body));
      return defaultFetch(DIM)("http://test-embed/v1/embeddings", init);
    }) as typeof fetch;

    await embed("hello");
    expect(Array.isArray(capturedBody.input)).toBe(true);
    expect(capturedBody.input).toEqual(["hello"]);
  });

  // ─── Retry behavior ────────────────────────────────────────────────────────

  it("retries 429 responses; eventually returns the embedding on success", async () => {
    let calls = 0;
    fetchImpl = (async (_input, init) => {
      calls++;
      if (calls < 3) return new Response("rate limited", { status: 429 });
      return defaultFetch(DIM)("http://test-embed/v1/embeddings", init);
    }) as typeof fetch;

    // 429 on calls 1+2, 200 on call 3 (probe completes). Then call 4 is the
    // actual embed batch — also succeeds. Net: 4 calls, no throw.
    const out = await embed("hi");
    expect(out.length).toBe(DIM);
    expect(calls).toBe(4);
  });

it("throws EmbedError('rate_limited') when 429 persists past 3 retries", async () => {
    let calls = 0;
    fetchImpl = (async () => {
      calls++;
      return new Response("rate limited", { status: 429 });
    }) as typeof fetch;

    await expect(embed("hi")).rejects.toMatchObject({
      name: "EmbedError",
      code: "rate_limited",
      status: 429,
    });
    // 3 attempts: initial + 2 retries.
    expect(calls).toBe(3);
  });

  it("does NOT retry on 401 — throws EmbedError('auth') immediately", async () => {
    let calls = 0;
    fetchImpl = (async () => {
      calls++;
      return new Response("unauthorized", { status: 401 });
    }) as typeof fetch;

    await expect(embed("hi")).rejects.toMatchObject({
      name: "EmbedError",
      code: "auth",
      status: 401,
    });
    expect(calls).toBe(1);
  });

  it("does NOT retry on 404 — throws EmbedError('model_not_found') immediately", async () => {
    let calls = 0;
    fetchImpl = (async () => {
      calls++;
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    await expect(embed("hi")).rejects.toMatchObject({
      name: "EmbedError",
      code: "model_not_found",
      status: 404,
    });
    expect(calls).toBe(1);
  });

  it("does NOT retry on 400 — throws EmbedError('bad_request') immediately", async () => {
    let calls = 0;
    fetchImpl = (async () => {
      calls++;
      return new Response("bad", { status: 400 });
    }) as typeof fetch;

    await expect(embed("hi")).rejects.toMatchObject({
      name: "EmbedError",
      code: "bad_request",
      status: 400,
    });
    expect(calls).toBe(1);
  });

  // ─── Network errors ────────────────────────────────────────────────────────

  it("throws EmbedError('unreachable') on TypeError (ECONNREFUSED-like)", async () => {
    fetchImpl = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;

    await expect(embed("hi")).rejects.toMatchObject({
      name: "EmbedError",
      code: "unreachable",
    });
  });

  // ─── Parse errors ──────────────────────────────────────────────────────────

  it("throws EmbedError('parse') on non-JSON response", async () => {
    fetchImpl = (async () => new Response("<html>nope</html>", { status: 200 })) as typeof fetch;
    await expect(embed("hi")).rejects.toMatchObject({ name: "EmbedError", code: "parse" });
  });

  it("throws EmbedError('parse') when response has no data array", async () => {
    fetchImpl = (async () => jsonResponse(200, { error: "oops" })) as typeof fetch;
    await expect(embed("hi")).rejects.toMatchObject({ name: "EmbedError", code: "parse" });
  });

  it("throws EmbedError('parse') when data item has no embedding[]", async () => {
    fetchImpl = (async () => jsonResponse(200, {
      data: [{ index: 0, embedding: "not an array" }],
    })) as typeof fetch;
    await expect(embed("hi")).rejects.toMatchObject({ name: "EmbedError", code: "parse" });
  });

  it("throws EmbedError('parse') when batch size mismatch", async () => {
    fetchImpl = (async (_input, init) => {
      // Return only 1 embedding for a batch of 2 inputs.
      const body = JSON.parse(String(init?.body)) as { input: string | string[] };
      const wanted = Array.isArray(body.input) ? body.input.length : 1;
      return jsonResponse(200, {
        data: [{ index: 0, embedding: Array.from({ length: DIM }, () => 0) }],
        // wanted is used to keep TS happy; we intentionally return 1 when >1 was asked
        _wanted: wanted,
      });
    }) as typeof fetch;
    await expect(embedBatch(["a", "b"])).rejects.toMatchObject({
      name: "EmbedError",
      code: "parse",
    });
  });

  // ─── Defensive ordering ────────────────────────────────────────────────────

  it("sorts server response by `index` defensively", async () => {
    fetchImpl = (async () => jsonResponse(200, {
      data: [
        // Returned out of order: index 2 first, then 0, then 1.
        { index: 2, embedding: Array.from({ length: DIM }, (_, k) => 0.2 + k * 0.001) },
        { index: 0, embedding: Array.from({ length: DIM }, (_, k) => 0.0 + k * 0.001) },
        { index: 1, embedding: Array.from({ length: DIM }, (_, k) => 0.1 + k * 0.001) },
      ],
    })) as typeof fetch;

    const out = await embedBatch(["a", "b", "c"]);
    expect(out[0][0]).toBeCloseTo(0.0, 5);
    expect(out[1][0]).toBeCloseTo(0.1, 5);
    expect(out[2][0]).toBeCloseTo(0.2, 5);
  });

  // ─── Probe caching ────────────────────────────────────────────────────────

  it("probe() caches dim after first call; subsequent embeds do not re-probe", async () => {
    let calls = 0;
    fetchImpl = (async (input, init) => {
      calls++;
      return defaultFetch(DIM)(input, init);
    }) as typeof fetch;

    // First batch: 1 probe call + 1 batch call = 2 total.
    await embedBatch(["a", "b", "c", "d", "e"]);
    const callsAfterFirstBatch = calls;
    expect(callsAfterFirstBatch).toBe(2);

    // Second batch: 0 probe calls (cached) + 1 batch call = 1 more.
    await embedBatch(["f", "g"]);
    expect(calls).toBe(callsAfterFirstBatch + 1);
  });

  // ─── Dim mismatch ─────────────────────────────────────────────────────────

  it("throws EmbedError('dim_mismatch') when server dim disagrees with config hint", async () => {
    process.env.PI_RAG_EMBED_DIMENSIONS = "768";   // config says 768
    fetchImpl = defaultFetch(384);                  // server returns 384
    __resetProbeForTests();                          // forget any cached probe

    await expect(embed("hi")).rejects.toMatchObject({
      name: "EmbedError",
      code: "dim_mismatch",
    });
    delete process.env.PI_RAG_EMBED_DIMENSIONS;
  });

  it("throws EmbedError('dim_mismatch') when a vector in a batch has wrong length", async () => {
    fetchImpl = (async (_input, init) => {
      // First request (probe) → 384. Subsequent batched calls → first vector 384, second vector 768.
      const body = JSON.parse(String(init?.body)) as { input: string | string[] };
      const inputs = Array.isArray(body.input) ? body.input : [body.input];
      return jsonResponse(200, {
        data: inputs.map((text, index) => ({
          index,
          embedding: Array.from({ length: index === 1 ? 768 : 384 }, (_, k) => Math.sin(text.length + k) * 0.1),
        })),
      });
    }) as typeof fetch;

    await expect(embedBatch(["a", "b"])).rejects.toMatchObject({
      name: "EmbedError",
      code: "dim_mismatch",
    });
  });

  // ─── Progress callback ────────────────────────────────────────────────────

  it("fires onProgress once per batch with monotonically increasing i", async () => {
    // Force BATCH_SIZE=64 boundary by issuing 130 inputs (3 batches: 64, 64, 2).
    const inputs = Array.from({ length: 130 }, (_, i) => `text-${i}`);
    const progress: Array<{ i: number; total: number }> = [];
    await embedBatch(inputs, (i, total) => progress.push({ i, total }));
    expect(progress.length).toBe(3);
    expect(progress[0]).toEqual({ i: 64, total: 130 });
    expect(progress[1]).toEqual({ i: 128, total: 130 });
    expect(progress[2]).toEqual({ i: 130, total: 130 });
  });
});
