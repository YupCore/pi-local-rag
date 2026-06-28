/**
 * Embedding tests — exercise a LIVE OpenAI-compatible /v1/embeddings endpoint.
 *
 * pi-local-rag no longer ships a bundled embedding model. To run these tests
 * you must have an embedding server reachable at PI_RAG_EMBED_BASE_URL with
 * PI_RAG_EMBED_MODEL loaded. Examples:
 *
 *   # llama.cpp
 *   llama-server --model ./nomic-embed-text.Q8_0.gguf --embedding --pooling mean --port 8080
 *   PI_RAG_EMBED_BASE_URL=http://localhost:8080 \
 *   PI_RAG_EMBED_MODEL=nomic-embed-text \
 *   PI_RAG_EMBED_LIVE=1 npm test -- embedding.live
 *
 *   # Ollama
 *   ollama pull nomic-embed-text
 *   PI_RAG_EMBED_BASE_URL=http://localhost:11434 \
 *   PI_RAG_EMBED_MODEL=nomic-embed-text \
 *   PI_RAG_EMBED_LIVE=1 npm test -- embedding.live
 *
 * This file lives separately from __tests__/index.test.ts because that file
 * stubs globalThis.fetch with deterministic 384-dim vectors, which trivially
 * fails semantic-similarity checks.
 *
 * Skipped by default — set PI_RAG_EMBED_LIVE=1 to opt in.
 */
import { describe, it, expect, afterEach } from "vitest";
import Database from "better-sqlite3";
import { load as loadVec } from "sqlite-vec";
import {
  embed, cosineSimilarity, hybridSearch, sha256, initSchema,
  getVectorDim,
} from "../index.ts";

const skip = process.env.PI_RAG_EMBED_LIVE !== "1";
const EMBED_TIMEOUT = 120_000;

// Close the cached DB singleton + reset embed probe cache after every test so
// neither leaks into the next test.
afterEach(async () => {
  const { closeDbConn } = await import("../db.ts");
  closeDbConn();
  const { __resetProbeForTests } = await import("../embed.ts");
  __resetProbeForTests();
});

describe("embed (live HTTP)", () => {
  it.skipIf(skip)("returns a unit-normalized vector of the configured dim", async () => {
    const v = await embed("hello world");
    expect(Array.isArray(v)).toBe(true);
    expect(v.length).toBeGreaterThan(0);
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    // OpenAI/llama.cpp with --pooling mean return unit-normalized vectors.
    // Allow a generous tolerance — some servers normalize within epsilon.
    expect(Math.abs(norm - 1)).toBeLessThan(1e-2);
    expect(v.some(x => x !== 0)).toBe(true);
  }, EMBED_TIMEOUT);

  it.skipIf(skip)("deterministic — same input produces same output", async () => {
    const a = await embed("the quick brown fox jumps over the lazy dog");
    const b = await embed("the quick brown fox jumps over the lazy dog");
    expect(a.length).toBe(b.length);
    for (let i = 0; i < a.length; i++) {
      expect(Math.abs(a[i] - b[i])).toBeLessThan(1e-6);
    }
  }, EMBED_TIMEOUT);

  it.skipIf(skip)("semantic similarity — related sentences are closer than unrelated ones", async () => {
    const cat = await embed("A cat sits on the windowsill watching birds.");
    const kitten = await embed("A small kitten is looking at sparrows through the window.");
    const finance = await embed("Quarterly revenue exceeded analyst expectations by twelve percent.");
    const simRelated = cosineSimilarity(cat, kitten);
    const simUnrelated = cosineSimilarity(cat, finance);
    // Threshold lowered vs. the original All-MiniLM-L6-v2 test: model-agnostic.
    expect(simRelated).toBeGreaterThan(simUnrelated + 0.1);
    expect(simRelated).toBeGreaterThan(0.3);
  }, EMBED_TIMEOUT);

  it.skipIf(skip)("hybridSearch: vector path retrieves semantically relevant chunks even without keyword overlap", async () => {
    // Build an in-memory DB with REAL embeddings — validates the semantic
    // vector path end-to-end through sqlite-vec.
    const chunks = [
      { content: "Photosynthesis is how plants convert sunlight into chemical energy.", file: "plants.md" },
      { content: "The team shipped a new dashboard for analytics reporting.", file: "shipping.md" },
      { content: "We pickled cucumbers in a vinegar brine with dill and garlic.", file: "recipe.md" },
    ];
    const vectors = await Promise.all(chunks.map(c => embed(c.content)));
    const dim = getVectorDim();

    const db = new Database(":memory:");
    db.pragma("journal_mode = WAL");
    loadVec(db);
    initSchema(db, dim);

    const insChunk = db.prepare(`
      INSERT INTO chunks(id, file_path, chunk_content, line_start, line_end, chunk_hash, indexed_at, tokens)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insVec = db.prepare("INSERT INTO chunks_vec(rowid, embedding) VALUES (CAST(? AS INTEGER), ?)");
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i];
      const r = insChunk.run(
        `${c.file}-1`, c.file, c.content, 1, 1, sha256(c.content),
        "2026-05-15T00:00:00Z", Math.ceil(c.content.length / 4),
      );
      const f = new Float32Array(vectors[i]);
      insVec.run(Number(r.lastInsertRowid), Buffer.from(f.buffer, f.byteOffset, f.byteLength));
    }

    const results = await hybridSearch(
      "How do leaves produce food from light?",
      3, 0, db,
    );
    db.close();

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].chunk.file).toBe("plants.md");
  }, EMBED_TIMEOUT);
});
