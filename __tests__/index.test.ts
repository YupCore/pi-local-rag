/**
 * Combined test suite for pi-local-rag.
 *
 * Each top-level `describe(...)` groups tests for one area of the module.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from "vitest";
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, relative, basename } from "node:path";
import { fileURLToPath } from "node:url";
import ignore from "ignore";
import Database from "better-sqlite3";
import { load as loadVec } from "sqlite-vec";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SAMPLE_PDF = readFileSync(join(__dirname, "fixtures", "sample.pdf"));
const SAMPLE_IMAGE_PDF = readFileSync(join(__dirname, "fixtures", "sample-image.pdf"));

// ─── fetch stub ─────────────────────────────────────────────────────────────
//
// pi-local-rag's embed.ts now POSTs to /v1/embeddings. We stub globalThis.fetch
// so tests don't reach the network and we keep deterministic 384-dim vectors.
//
// The default stub returns a deterministic, text-derived 384-dim vector so
// cosine-similarity assertions remain meaningful. Tests that need custom
// behavior (errors, custom dims, out-of-order responses) can reassign
// `currentFetchImpl` directly.

const DEFAULT_DIM = 384;
let currentFetchImpl: typeof fetch | null = null;
const originalFetch = globalThis.fetch;

function defaultEmbedFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = String(input);
  if (!url.endsWith("/v1/embeddings")) {
    return Promise.resolve(new Response("not found", { status: 404 }));
  }
  const body = JSON.parse(String(init?.body ?? "{}")) as { input: string | string[] };
  const inputs = Array.isArray(body.input) ? body.input : [body.input];
  return Promise.resolve(new Response(JSON.stringify({
    object: "list",
    model: "test-embed",
    data: inputs.map((text, index) => ({
      object: "embedding",
      index,
      // Deterministic hash → unit-ish vector. The exact values don't matter
      // for the search tests; what matters is that two equal inputs produce
      // equal vectors and two distinct inputs produce distinct vectors.
      embedding: Array.from({ length: DEFAULT_DIM }, (_, k) => {
        let h = 0;
        for (let i = 0; i < text.length; i++) h = ((h << 5) - h + text.charCodeAt(i)) | 0;
        return Math.sin(h + k) * 0.1;
      }),
    })),
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  }));
}

beforeAll(() => {
  // Pin the embed backend config so tests don't read random env state.
  process.env.PI_RAG_EMBED_BASE_URL = "http://test-embed";
  process.env.PI_RAG_EMBED_MODEL = "test-embed";
  process.env.PI_RAG_EMBED_API_KEY = "";
  // Tests use a 384-dim schema (matches the default test fixture).
  process.env.PI_RAG_EMBED_DIMENSIONS = "384";
});

beforeEach(() => {
  currentFetchImpl = defaultEmbedFetch;
  globalThis.fetch = ((...args: Parameters<typeof fetch>) => {
    if (!currentFetchImpl) throw new Error("fetch stub not installed");
    return currentFetchImpl(...args);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  currentFetchImpl = null;
});

// Imports that don't depend on env-time state can be static.
import {
  chunkText,
  cosineSimilarity,
  normalize,
  DEFAULT_TEXT_EXTS,
  normalizeExt,
  resolveExtensions,
  collectFiles,
  collectFromTracked,
  isExcludedByConfig,
  extractText,
  hybridSearch,
  embed,
  sha256,
  initSchema,
  getOcrTooling,
  isSparsePdfText,
} from "../index.ts";

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Create an in-memory SQLite DB with the RAG schema, pre-populated with chunks.
 *  Used by hybridSearch tests — avoids the per-file rag.db write overhead and
 *  isolates each test. */
function createTestDb(chunks: Array<{
  id?: string; file?: string; content: string; lineStart?: number; lineEnd?: number;
  vector?: number[];
}>): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  loadVec(db);
  initSchema(db, 384);

  const insChunk = db.prepare(`
    INSERT INTO chunks(id, file_path, chunk_content, line_start, line_end, chunk_hash, indexed_at, tokens)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insVec = db.prepare(
    "INSERT INTO chunks_vec(rowid, embedding) VALUES (CAST(? AS INTEGER), ?)",
  );
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    const result = insChunk.run(
      c.id ?? `chunk-${i}`,
      c.file ?? "/src/file.ts",
      c.content,
      c.lineStart ?? 1,
      c.lineEnd ?? 10,
      sha256(c.content),
      new Date().toISOString(),
      Math.ceil(c.content.length / 4),
    );
    if (c.vector) {
      const f = new Float32Array(c.vector);
      insVec.run(Number(result.lastInsertRowid), Buffer.from(f.buffer, f.byteOffset, f.byteLength));
    }
  }
  return db;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

async function buildMinimalDocx(text: string): Promise<Buffer> {
  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`,
  );
  zip.folder("_rels")!.file(
    ".rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
  );
  zip.folder("word")!.file(
    "document.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>${text}</w:t></w:r></w:p>
  </w:body>
</w:document>`,
  );
  return await zip.generateAsync({ type: "nodebuffer" });
}

function chunkFixture(file: string, content: string, lineStart = 1) {
  return {
    id: `${file}-${lineStart}`,
    file,
    content,
    lineStart,
    lineEnd: lineStart + content.split("\n").length - 1,
    hash: "abc",
    indexed: new Date().toISOString(),
    tokens: Math.ceil(content.length / 4),
  };
}

// ─── Test lifecycle: close the cached DB singleton after every test ──────────
// Close the cached DB singleton after every test so it can't leak into the next test
afterEach(async () => {
  const { closeDbConn } = await import("../db.ts");
  closeDbConn();
  // Reset embed.ts' cached probe dim so each test starts with a fresh probe.
  const { __resetProbeForTests } = await import("../embed.ts");
  __resetProbeForTests();
});

// ─── chunkText ──────────────────────────────────────────────────────────────

describe("chunkText", () => {
  it("short text under threshold returns a single chunk starting at line 1", () => {
    const text = "line one\nline two\nline three";
    const chunks = chunkText(text);
    expect(chunks.length).toBe(1);
    expect(chunks[0].lineStart).toBe(1);
    expect(chunks[0].lineEnd).toBe(3);
    expect(chunks[0].content).toBe(text);
  });

  it("text just under 20 chars after trimming is dropped", () => {
    expect(chunkText("tiny").length).toBe(0);
  });

  it("respects maxLines and produces consecutive line ranges", () => {
    const lines = Array.from({ length: 120 }, (_, i) => `line ${i + 1} content`);
    const chunks = chunkText(lines.join("\n"), 50);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks[0].lineStart).toBe(1);
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i].lineStart, "consecutive chunks should be contiguous")
        .toBe(chunks[i - 1].lineEnd + 1);
    }
  });

  it("prefers breaking at blank lines near the window end", () => {
    const lines = Array.from({ length: 80 }, (_, i) => (i === 44 ? "" : `content line ${i + 1}`));
    const chunks = chunkText(lines.join("\n"), 50);
    expect(chunks[0].lineEnd).toBe(45);
  });

  it("does not lose lines across the boundary", () => {
    const lines = Array.from({ length: 200 }, (_, i) => `data ${i}`);
    const chunks = chunkText(lines.join("\n"), 50);
    expect(chunks[chunks.length - 1].lineEnd).toBe(200);
  });
});

// ─── math: cosineSimilarity, normalize ──────────────────────────────────────

describe("cosineSimilarity", () => {
  it("identical vectors = 1", () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBe(1);
  });
  it("orthogonal vectors = 0", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
  });
  it("opposite vectors = -1", () => {
    expect(cosineSimilarity([1, 2, 3], [-1, -2, -3])).toBe(-1);
  });
  it("scale-invariant", () => {
    expect(Math.abs(cosineSimilarity([1, 2, 3], [2, 4, 6]) - 1)).toBeLessThan(1e-9);
  });
  it("mismatched lengths returns 0", () => {
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
  });
  it("zero vector returns 0 (no divide-by-zero)", () => {
    expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0);
  });
});

describe("normalize", () => {
  it("maps to [0,1] preserving order", () => {
    const out = normalize([10, 0, 5]);
    expect(out[0]).toBe(1);
    expect(out[1]).toBe(0);
    expect(out[2]).toBe(0.5);
  });
  it("all-equal input returns all zeros", () => {
    expect(normalize([3, 3, 3])).toEqual([0, 0, 0]);
  });
  it("single value returns [0]", () => {
    expect(normalize([7])).toEqual([0]);
  });
});

// ─── extensions ─────────────────────────────────────────────────────────────

describe("normalizeExt", () => {
  it("adds leading dot and lowercases", () => {
    expect(normalizeExt("cs")).toBe(".cs");
    expect(normalizeExt(".CS")).toBe(".cs");
    expect(normalizeExt("  .TeX  ")).toBe(".tex");
    expect(normalizeExt("")).toBe("");
    expect(normalizeExt("   ")).toBe("");
  });
});

describe("resolveExtensions", () => {
  it("returns the default set when no overrides", () => {
    const exts = resolveExtensions({ extraExtensions: [], excludeExtensions: [] });
    for (const e of DEFAULT_TEXT_EXTS) expect(exts.has(e), `default ${e} missing`).toBe(true);
    expect(exts.size).toBe(DEFAULT_TEXT_EXTS.length);
  });
  it("default set covers common languages including the ones from issue #9", () => {
    const exts = resolveExtensions({ extraExtensions: [], excludeExtensions: [] });
    for (const e of [".cs", ".tsx", ".jsx", ".kt", ".swift", ".rb", ".php", ".lua", ".vue", ".svelte"]) {
      expect(exts.has(e), `expected default set to include ${e}`).toBe(true);
    }
  });
  it("extraExtensions are added and normalized", () => {
    const exts = resolveExtensions({ extraExtensions: ["tex", ".ZIG", " .nix "], excludeExtensions: [] });
    expect(exts.has(".tex")).toBe(true);
    expect(exts.has(".zig")).toBe(true);
    expect(exts.has(".nix")).toBe(true);
  });
  it("excludeExtensions remove from the default set", () => {
    const exts = resolveExtensions({ extraExtensions: [], excludeExtensions: [".md", "JSON"] });
    expect(exts.has(".md")).toBe(false);
    expect(exts.has(".json")).toBe(false);
    expect(exts.has(".ts")).toBe(true);
  });
  it("empty/whitespace entries are ignored", () => {
    const baseline = resolveExtensions({ extraExtensions: [], excludeExtensions: [] }).size;
    const exts = resolveExtensions({ extraExtensions: ["", "   "], excludeExtensions: ["", "  "] });
    expect(exts.size).toBe(baseline);
  });
});

// ─── collectFiles ───────────────────────────────────────────────────────────

describe("collectFiles", () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "pi-rag-test-")); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it("walks dir, applies extension allowlist, skips node_modules and dotdirs", () => {
    writeFileSync(join(tmp, "a.ts"), "export const a = 1;");
    writeFileSync(join(tmp, "b.md"), "# heading");
    writeFileSync(join(tmp, "c.bin"), Buffer.from([0, 1, 2, 3]));
    writeFileSync(join(tmp, "image.png"), Buffer.alloc(10));
    mkdirSync(join(tmp, "node_modules"));
    writeFileSync(join(tmp, "node_modules", "skip.ts"), "// should not be indexed");
    mkdirSync(join(tmp, ".git"));
    writeFileSync(join(tmp, ".git", "config"), "x");
    mkdirSync(join(tmp, ".hidden"));
    writeFileSync(join(tmp, ".hidden", "secret.ts"), "// hidden");
    mkdirSync(join(tmp, "src"));
    writeFileSync(join(tmp, "src", "deep.py"), "print('hi')");
    writeFileSync(join(tmp, "huge.ts"), "x".repeat(500_001));

    const files = collectFiles(tmp).map(f => f.replace(tmp, "").replaceAll("\\", "/")).sort();
    expect(files).toContain("/a.ts");
    expect(files).toContain("/b.md");
    expect(files).toContain("/src/deep.py");
    expect(files.some(f => f.includes("node_modules"))).toBe(false);
    expect(files.some(f => f.includes(".git"))).toBe(false);
    expect(files.some(f => f.includes(".hidden"))).toBe(false);
    expect(files.some(f => f.endsWith(".bin") || f.endsWith(".png"))).toBe(false);
    expect(files.some(f => f.endsWith("huge.ts"))).toBe(false);
  });

  it("file path returns single entry when extension allowed", () => {
    const fp = join(tmp, "single.ts");
    writeFileSync(fp, "export {};");
    expect(collectFiles(fp)).toEqual([fp]);
  });

  it("file path returns empty when extension not allowed", () => {
    const fp = join(tmp, "data.bin");
    writeFileSync(fp, "x");
    expect(collectFiles(fp)).toEqual([]);
  });

  it("nonexistent path returns empty", () => {
    expect(collectFiles(join(tmpdir(), "definitely-not-here-xyz-12345"))).toEqual([]);
  });

  it("picks up .pdf and .docx even without being in TEXT_EXTS", () => {
    writeFileSync(join(tmp, "doc.pdf"), Buffer.from("%PDF-1.4 stub"));
    writeFileSync(join(tmp, "doc.docx"), Buffer.from("PK\x03\x04 stub"));
    writeFileSync(join(tmp, "a.ts"), "x");
    const files = collectFiles(tmp).map(f => f.replace(tmp, "").replaceAll("\\", "/")).sort();
    expect(files).toContain("/doc.pdf");
    expect(files).toContain("/doc.docx");
    expect(files).toContain("/a.ts");
  });

  it("9 MB PDF accepted, 500 KB text rejected", () => {
    writeFileSync(join(tmp, "big.pdf"), Buffer.alloc(9_000_000));
    writeFileSync(join(tmp, "big.txt"), "x".repeat(500_000));
    const files = collectFiles(tmp).map(f => f.replace(tmp, "").replaceAll("\\", "/")).sort();
    expect(files).toContain("/big.pdf");
    expect(files.some(f => f.endsWith("big.txt"))).toBe(false);
  });

  it("PDF over 10 MB cap is rejected", () => {
    writeFileSync(join(tmp, "huge.pdf"), Buffer.alloc(10_000_000));
    expect(collectFiles(tmp).length).toBe(0);
  });

  it("custom extension set is honored", () => {
    writeFileSync(join(tmp, "a.ts"), "x");
    writeFileSync(join(tmp, "b.cs"), "x");
    const files = collectFiles(tmp, new Set([".cs"]));
    expect(files.length).toBe(1);
    expect(files[0].endsWith("b.cs")).toBe(true);
  });

  it("excludePatterns filters a top-level file", () => {
    writeFileSync(join(tmp, "a.ts"), "x");
    writeFileSync(join(tmp, "b.ts"), "x");
    const files = collectFiles(tmp, undefined, ["b.ts"]).map(f => f.replace(tmp, "").replaceAll("\\", "/"));
    expect(files).not.toContain("/b.ts");
    expect(files).toContain("/a.ts");
  });

  it("excludePatterns filters a whole directory subtree", () => {
    writeFileSync(join(tmp, "a.ts"), "x");
    mkdirSync(join(tmp, "gen"));
    writeFileSync(join(tmp, "gen", "ignored.ts"), "x");
    const files = collectFiles(tmp, undefined, ["gen/"]).map(f => f.replace(tmp, "").replaceAll("\\", "/"));
    expect(files.some(f => f.includes("/gen/"))).toBe(false);
    expect(files).toContain("/a.ts");
  });

  it("extension glob exclude", () => {
    writeFileSync(join(tmp, "page.html"), "<p>x</p>");
    writeFileSync(join(tmp, "a.ts"), "x");
    const files = collectFiles(tmp, undefined, ["*.html"]).map(f => f.replace(tmp, "").replaceAll("\\", "/"));
    expect(files.some(f => f.endsWith(".html"))).toBe(false);
    expect(files.some(f => f.endsWith(".ts"))).toBe(true);
  });
});

// ─── collectFromTracked + isExcludedByConfig ────────────────────────────────

describe("collectFromTracked", () => {
  it("walks every tracked path, dedupes overlaps", () => {
    const a = mkdtempSync(join(tmpdir(), "rag-track-a-"));
    const b = mkdtempSync(join(tmpdir(), "rag-track-b-"));
    try {
      writeFileSync(join(a, "x.ts"), "x");
      writeFileSync(join(b, "y.ts"), "y");
      const cfg = {
        ragEnabled: true, ragTopK: 5, ragScoreThreshold: 0.1, ragAlpha: 0.4,
        extraExtensions: [], excludeExtensions: [],
        trackedPaths: [a, b, a],
        excludePatterns: [],
      };
      const files = collectFromTracked(cfg);
      expect(files.filter(f => f.endsWith("x.ts")).length).toBe(1);
      expect(files.some(f => f.endsWith("x.ts"))).toBe(true);
      expect(files.some(f => f.endsWith("y.ts"))).toBe(true);
    } finally {
      rmSync(a, { recursive: true, force: true });
      rmSync(b, { recursive: true, force: true });
    }
  });

  it("silently skips non-existent tracked paths", () => {
    const a = mkdtempSync(join(tmpdir(), "rag-track-a-"));
    try {
      writeFileSync(join(a, "x.ts"), "x");
      const cfg = {
        ragEnabled: true, ragTopK: 5, ragScoreThreshold: 0.1, ragAlpha: 0.4,
        extraExtensions: [], excludeExtensions: [],
        trackedPaths: [a, "/definitely/not/a/real/dir-xyz-123"],
        excludePatterns: [],
      };
      expect(collectFromTracked(cfg).length).toBe(1);
    } finally {
      rmSync(a, { recursive: true, force: true });
    }
  });

  it("applies excludePatterns per tracked root", () => {
    const root = mkdtempSync(join(tmpdir(), "rag-track-"));
    try {
      writeFileSync(join(root, "a.ts"), "x");
      mkdirSync(join(root, "gen"));
      writeFileSync(join(root, "gen", "ignored.ts"), "x");
      const cfg = {
        ragEnabled: true, ragTopK: 5, ragScoreThreshold: 0.1, ragAlpha: 0.4,
        extraExtensions: [], excludeExtensions: [],
        trackedPaths: [root],
        excludePatterns: ["gen/"],
      };
      const files = collectFromTracked(cfg);
      expect(files.some(f => f.includes("/gen/"))).toBe(false);
      expect(files.some(f => f.endsWith("a.ts"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("isExcludedByConfig", () => {
  it("false when no patterns", () => {
    expect(isExcludedByConfig("/repo/a.ts", ["/repo"], [])).toBe(false);
  });
  it("matches a file relative to a root", () => {
    expect(isExcludedByConfig("/repo/gen/x.ts", ["/repo"], ["gen/"])).toBe(true);
    expect(isExcludedByConfig("/repo/src/x.ts", ["/repo"], ["gen/"])).toBe(false);
  });
  it("tries all roots; returns true if any matches", () => {
    expect(isExcludedByConfig("/repo-b/gen/x.ts", ["/repo-a", "/repo-b"], ["gen/"])).toBe(true);
  });
  it("file outside every root is not excluded", () => {
    expect(isExcludedByConfig("/elsewhere/a.ts", ["/repo"], ["*.ts"])).toBe(false);
  });
});

// ─── collectFilesAsync / collectFromTrackedAsync ────────────────────────────

describe("collectFilesAsync", () => {
  it("walks a tree like the sync version (extension allowlist, skip dirs, size caps)", async () => {
    const root = mkdtempSync(join(tmpdir(), "rag-async-walk-"));
    try {
      writeFileSync(join(root, "a.ts"), "x");
      writeFileSync(join(root, "b.md"), "x");
      writeFileSync(join(root, "huge.ts"), "x".repeat(500_001));
      mkdirSync(join(root, "node_modules"));
      writeFileSync(join(root, "node_modules", "skip.ts"), "x");
      mkdirSync(join(root, "src"));
      writeFileSync(join(root, "src", "deep.py"), "x");

      const { collectFilesAsync } = await import("../index.ts");
      const files = (await collectFilesAsync(root)).map(f => f.replace(root, "").replaceAll("\\", "/")).sort();
      expect(files).toContain("/a.ts");
      expect(files).toContain("/b.md");
      expect(files).toContain("/src/deep.py");
      expect(files.some(f => f.includes("node_modules"))).toBe(false);
      expect(files.some(f => f.endsWith("huge.ts"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("excludePatterns work the same as in the sync collectFiles", async () => {
    const root = mkdtempSync(join(tmpdir(), "rag-async-excl-"));
    try {
      writeFileSync(join(root, "page.html"), "<p>x</p>");
      writeFileSync(join(root, "a.ts"), "x");
      const { collectFilesAsync } = await import("../index.ts");
      const files = (await collectFilesAsync(root, undefined, ["*.html"])).map(f => f.replace(root, "").replaceAll("\\", "/"));
      expect(files.some(f => f.endsWith(".html"))).toBe(false);
      expect(files.some(f => f.endsWith(".ts"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ─── indexFiles force flag ──────────────────────────────────────────────────

describe("indexFiles --force", () => {
  let tmp: string;
  let savedRagDir: string | undefined;
  let mod: typeof import("../index.ts");

  beforeAll(async () => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), "rag-force-")));
    savedRagDir = process.env.PI_RAG_DIR;
    process.env.PI_RAG_DIR = tmp;
    vi.resetModules();
    mod = await import("../index.ts");
  });

  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
    if (savedRagDir !== undefined) process.env.PI_RAG_DIR = savedRagDir;
    else delete process.env.PI_RAG_DIR;
  });

  it("second pass: skips unchanged files by default; re-embeds them when force=true", async () => {
    const proj = mkdtempSync(join(tmpdir(), "rag-force-proj-"));
    try {
      const fp = join(proj, "stable.ts");
      writeFileSync(fp, "export const stable = 1;\n");

      // First pass: file is fresh, gets indexed.
      const r1 = await mod.indexFiles([fp]);
      expect(r1.indexed).toBe(1);
      expect(r1.skipped).toBe(0);

      // Second pass without force: hash matches → file should be skipped.
      const r2 = await mod.indexFiles([fp]);
      expect(r2.skipped).toBe(1);
      expect(r2.indexed).toBe(0);

      // Third pass with force=true: re-embeds the file even though the hash
      // hasn't changed.
      const r3 = await mod.indexFiles([fp], undefined, undefined, true);
      expect(r3.indexed).toBe(1);
      expect(r3.skipped).toBe(0);
    } finally {
      rmSync(proj, { recursive: true, force: true });
    }
  });
});

// ─── extractText (plain / PDF / DOCX / HTML) ────────────────────────────────

describe("extractText", () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "rag-extract-")); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it("reads plain text files as utf-8", async () => {
    const fp = join(tmp, "a.txt");
    writeFileSync(fp, "hello world");
    const { text, hash, size } = await extractText(fp);
    expect(text).toBe("hello world");
    expect(hash).toMatch(/^[0-9a-f]{12}$/);
    expect(size).toBe(11);
  });

  it("extracts text from a .pdf", async () => {
    const fp = join(tmp, "a.pdf");
    writeFileSync(fp, SAMPLE_PDF);
    const { text, hash, size } = await extractText(fp);
    expect(text).toContain("RagPdfMarker");
    expect(hash).toMatch(/^[0-9a-f]{12}$/);
    expect(size).toBe(SAMPLE_PDF.length);
  });

  it("extracts text from a .docx", async () => {
    const fp = join(tmp, "a.docx");
    writeFileSync(fp, await buildMinimalDocx("RagDocxMarker"));
    const { text } = await extractText(fp);
    expect(text).toContain("RagDocxMarker");
  });

  it("silences pdfjs Warning/Info console output during PDF parse", async () => {
    const fp = join(tmp, "loud.pdf");
    writeFileSync(fp, SAMPLE_PDF);
    const leaked: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => {
      const first = args[0];
      if (typeof first === "string" && /^(Warning|Info|Deprecated API usage):/.test(first)) {
        leaked.push(first);
      }
    };
    try {
      const r = await extractText(fp);
      expect(r.text).toContain("RagPdfMarker");
    } finally {
      console.log = origLog;
    }
    expect(leaked.length).toBe(0);
  });

  it("hash is stable across reads of the same binary file (skip-on-rebuild)", async () => {
    const fp = join(tmp, "stable.pdf");
    writeFileSync(fp, SAMPLE_PDF);
    const a = await extractText(fp);
    const b = await extractText(fp);
    expect(a.hash).toBe(b.hash);
  });
});

describe("extractText HTML", () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "rag-html-")); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it("converts simple HTML to markdown", async () => {
    const fp = join(tmp, "simple.html");
    writeFileSync(fp, "<p>Hello <strong>world</strong></p>");
    const { text } = await extractText(fp);
    expect(text).toContain("Hello");
    expect(text).toContain("world");
    expect(text).not.toContain("<p>");
    expect(text).not.toContain("<strong>");
  });

  it("removes script and style blocks", async () => {
    const fp = join(tmp, "no-script.html");
    writeFileSync(fp, "<p>Before</p><script>alert('xss')</script><style>.x{}</style><p>After</p>");
    const { text } = await extractText(fp);
    expect(text).toContain("Before");
    expect(text).toContain("After");
    expect(text).not.toContain("alert");
    expect(text).not.toContain(".x{}");
  });

  it("removes nav and footer elements", async () => {
    const fp = join(tmp, "no-nav.html");
    writeFileSync(fp, "<nav>Home | About</nav><p>Content</p><footer>Copyright</footer>");
    const { text } = await extractText(fp);
    expect(text).toContain("Content");
    expect(text).not.toContain("Home | About");
    expect(text).not.toContain("Copyright");
  });

  it("converts headings to atx style", async () => {
    const fp = join(tmp, "headings.html");
    writeFileSync(fp, "<h1>Title</h1><h2>Subtitle</h2><p>Body</p>");
    const { text } = await extractText(fp);
    expect(text).toContain("# Title");
    expect(text).toContain("## Subtitle");
    expect(text).toContain("Body");
  });

  it("fences code blocks", async () => {
    const fp = join(tmp, "code.html");
    writeFileSync(fp, '<pre><code class="lang-cs">var x = 1;</code></pre>');
    const { text } = await extractText(fp);
    expect(text).toContain("```");
    expect(text).toContain("var x = 1;");
  });

  it("converts lists to markdown", async () => {
    const fp = join(tmp, "lists.html");
    writeFileSync(fp, "<ul><li>One</li><li>Two</li></ul>");
    const { text } = await extractText(fp);
    expect(text).toContain("One");
    expect(text).toContain("Two");
    expect(text).not.toContain("<li>");
  });

  it("hashes the raw HTML, not the markdown", async () => {
    const fp = join(tmp, "hash-test.html");
    writeFileSync(fp, "<p>Content</p>");
    const { hash, text } = await extractText(fp);
    expect(hash).toMatch(/^[0-9a-f]{12}$/);
    expect(text).not.toContain("<p>");
  });

  it("handles real-world Unity doc HTML structure", async () => {
    const fp = join(tmp, "unity-doc.html");
    const html = `<!DOCTYPE html><html><head><script>var x = 1;</script></head>
<body><nav>Navigation</nav><div class="content"><h1>Add textures to the camera history</h1>
<p>To add your own texture to the <strong>camera</strong> history.</p>
<pre><code>public class Example : CameraHistoryItem { }</code></pre>
<ul><li>Step one</li><li>Step two</li></ul>
</div><footer>Copyright</footer></body></html>`;
    writeFileSync(fp, html);
    const { text } = await extractText(fp);
    expect(text).toContain("# Add textures to the camera history");
    expect(text).toContain("public class Example : CameraHistoryItem { }");
    expect(text).toContain("Step one");
    expect(text).toContain("Step two");
    expect(text).not.toContain("<script>");
    expect(text).not.toContain("var x");
    expect(text).not.toContain("Navigation");
    expect(text).not.toContain("Copyright");
  });

  it("also handles .htm extension", async () => {
    const fp = join(tmp, "page.htm");
    writeFileSync(fp, "<h1>Title</h1><p>Body</p>");
    const { text } = await extractText(fp);
    expect(text).toContain("# Title");
    expect(text).toContain("Body");
  });

  it("produces much smaller output than raw HTML for Unity docs", async () => {
    const fp = join(tmp, "big.html");
    const html = "<script>" + "x".repeat(5000) + "</script>"
      + "<style>" + "y".repeat(3000) + "</style>"
      + "<nav>" + "z".repeat(2000) + "</nav>"
      + "<p>Actual content here about framebuffer fetch</p>"
      + "<footer>" + "w".repeat(1000) + "</footer>";
    writeFileSync(fp, html);
    const { text } = await extractText(fp);
    expect(text.length).toBeLessThan(html.length / 2);
    expect(text).toContain("Actual content here about framebuffer fetch");
    expect(text).not.toContain("x".repeat(100));
  });
});

// ─── OCR fallback ────────────────────────────────────────────────────────────

describe("isSparsePdfText", () => {
  it("empty text → sparse", () => {
    expect(isSparsePdfText("", 1)).toBe(true);
  });
  it("just below 50 chars/page → sparse", () => {
    expect(isSparsePdfText("x".repeat(49), 1)).toBe(true);
  });
  it("at the 50-char threshold → not sparse", () => {
    expect(isSparsePdfText("x".repeat(50), 1)).toBe(false);
  });
  it("scales with page count", () => {
    expect(isSparsePdfText("x".repeat(150), 3)).toBe(false);
    expect(isSparsePdfText("x".repeat(149), 3)).toBe(true);
  });
  it("numpages of 0 is treated as 1", () => {
    expect(isSparsePdfText("x".repeat(49), 0)).toBe(true);
    expect(isSparsePdfText("x".repeat(50), 0)).toBe(false);
  });
});

describe("getOcrTooling", () => {
  it("returns a stable shape", () => {
    const r = getOcrTooling();
    if (r.available) {
      expect(typeof r.langs).toBe("string");
      expect(r.langs.length).toBeGreaterThan(0);
    } else {
      expect(r).toEqual({ available: false });
    }
  });
  it("is cached across calls", () => {
    expect(getOcrTooling()).toBe(getOcrTooling());
  });
});

const ocrTools = getOcrTooling();
describe.skipIf(!ocrTools.available)("OCR end-to-end", () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "rag-ocr-test-")); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it("OCRs an image-only PDF and returns the rendered text", async () => {
    const fp = join(tmp, "image.pdf");
    writeFileSync(fp, SAMPLE_IMAGE_PDF);
    const { text } = await extractText(fp);
    expect(text).toMatch(/OcrMarker/);
  }, 60_000);
});

// ─── hybridSearch (FTS5 BM25 + sqlite-vec) ──────────────────────────────────
// Populate an in-memory DB via
// createTestDb() and pass it to hybridSearch's optional _db arg.

describe("hybridSearch (BM25 via FTS5, no vectors)", () => {
  it("empty index → []", async () => {
    const db = createTestDb([]);
    const results = await hybridSearch("query", 10, 0.4, db);
    db.close();
    expect(results).toEqual([]);
  });

  it("returns scored result for matching content", async () => {
    const db = createTestDb([
      { content: "function authenticate(user, password) { return checkCredentials(user, password); }" },
      { content: "function renderTemplate(html) { return sanitize(html); }" },
    ]);
    const results = await hybridSearch("authenticate", 10, 1.0, db);
    db.close();
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].chunk.content).toContain("authenticate");
  });

  it("non-matching query → no results", async () => {
    const db = createTestDb([{ content: "function computeSquareRoot(n) { return Math.sqrt(n); }" }]);
    const results = await hybridSearch("unrelated query term xyz", 10, 1.0, db);
    db.close();
    const nonZero = results.filter(r => r.hybrid > 0);
    expect(nonZero.length).toBe(0);
  });

  it("exact phrase match scores higher than partial match", async () => {
    const db = createTestDb([
      { content: "function handle user authentication: validate token from request" },
      { content: "function handle request: process data from input" },
    ]);
    const results = await hybridSearch("user authentication", 10, 1.0, db);
    db.close();
    const first = results[0]?.chunk.content ?? "";
    expect(first).toContain("authentication");
  });

  it("respects limit parameter", async () => {
    const chunks = Array.from({ length: 10 }, (_, i) => ({
      content: `function processItem${i}(value) { return transform(value); }`,
    }));
    const db = createTestDb(chunks);
    const results = await hybridSearch("function process", 3, 1.0, db);
    db.close();
    expect(results.length).toBeLessThanOrEqual(3);
  });

  it("result shape has bm25, vector, hybrid, chunk fields", async () => {
    const db = createTestDb([{ content: "export function calculateTotal(items) { return items.reduce((a, b) => a + b, 0); }" }]);
    const results = await hybridSearch("calculate total", 10, 1.0, db);
    db.close();
    if (results.length > 0) {
      expect(results[0]).toHaveProperty("bm25");
      expect(results[0]).toHaveProperty("vector");
      expect(results[0]).toHaveProperty("hybrid");
      expect(results[0]).toHaveProperty("chunk");
    }
  });

  it("filename boost: first query term matching filename scores higher", async () => {
    const db = createTestDb([
      { file: "/src/auth module", content: "export function login for user verification" },
      { file: "/src/render module", content: "export function display for user rendering" },
    ]);
    const results = await hybridSearch("auth user", 10, 1.0, db);
    db.close();
    expect(results[0]?.chunk.file).toContain("auth");
  });
});

describe("hybridSearch with vectors", () => {
  const vec = (seed: number) => Array.from({ length: 384 }, (_, i) => (i === seed ? 1 : 0));

  it("uses vector scores when chunks have embeddings", async () => {
    const db = createTestDb([
      { content: "handle user login with password verification and auth", vector: vec(0) },
      { content: "render the homepage template with context data", vector: vec(1) },
    ]);
    const results = await hybridSearch("login", 10, 0.5, db);
    db.close();
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]).toHaveProperty("bm25");
    expect(results[0]).toHaveProperty("vector");
    expect(results[0]).toHaveProperty("hybrid");
  });

  it("hybrid score is blend of bm25 and vector when alpha=0.5", async () => {
    const db = createTestDb([
      { content: "authenticate user credentials and verify identity", vector: vec(0) },
      { content: "logout session token and destroy active session", vector: vec(1) },
    ]);
    const results = await hybridSearch("authenticate", 10, 0.5, db);
    db.close();
    expect(results.length).toBeGreaterThan(0);
    const r = results[0];
    const expectedHybrid = 0.5 * r.bm25 + 0.5 * r.vector;
    expect(r.hybrid).toBeCloseTo(expectedHybrid, 5);
  });

  it("falls back to pure bm25 when no chunks have valid vectors", async () => {
    const db = createTestDb([
      { content: "process payment amount through payment gateway charge" },
      { content: "refund order through payment gateway refund" },
    ]);
    const results = await hybridSearch("payment", 10, 0.5, db);
    db.close();
    if (results.length > 0) {
      expect(results[0].hybrid).toBe(results[0].bm25);
    }
  });
});

// ─── /rag find glob matching ────────────────────────────────────────────────

describe("/rag find glob matching", () => {
  function findMatches(indexedFiles: string[], glob: string, cwd: string): string[] {
    const ig = ignore().add([glob]);
    const matches: string[] = [];
    for (const fp of indexedFiles) {
      const rel = relative(cwd, fp);
      const candidate = rel && !rel.startsWith("..") ? rel : basename(fp);
      if (ig.ignores(candidate)) matches.push(fp);
    }
    return matches.sort();
  }

  it("matches by extension glob (*.ts)", () => {
    const files = ["/repo/src/a.ts", "/repo/src/b.js", "/repo/test/c.ts", "/repo/README.md"];
    expect(findMatches(files, "*.ts", "/repo")).toEqual(["/repo/src/a.ts", "/repo/test/c.ts"]);
  });
  it("matches by basename prefix (page*)", () => {
    const files = ["/repo/page1.html", "/repo/page2.html", "/repo/about.html"];
    expect(findMatches(files, "page*", "/repo")).toEqual(["/repo/page1.html", "/repo/page2.html"]);
  });
  it("matches a directory subtree (src/)", () => {
    const files = ["/repo/src/a.ts", "/repo/src/inner/b.ts", "/repo/test/c.ts"];
    const m = findMatches(files, "src", "/repo");
    expect(m).toContain("/repo/src/a.ts");
    expect(m).toContain("/repo/src/inner/b.ts");
    expect(m).not.toContain("/repo/test/c.ts");
  });
  it("returns empty when nothing matches", () => {
    expect(findMatches(["/repo/a.ts", "/repo/b.md"], "*.py", "/repo")).toEqual([]);
  });
  it("falls back to basename for files outside cwd", () => {
    expect(findMatches(["/elsewhere/notes.md", "/repo/src/a.ts"], "notes.md", "/repo")).toEqual(["/elsewhere/notes.md"]);
  });
  it("exact filename glob", () => {
    const m = findMatches(["/repo/src/foo.js", "/repo/lib/foo.js", "/repo/src/bar.js"], "foo.js", "/repo");
    expect(m).toContain("/repo/src/foo.js");
    expect(m).toContain("/repo/lib/foo.js");
    expect(m).not.toContain("/repo/src/bar.js");
  });
});

// ─── embed + hybrid (live HTTP pipeline; opt-in via PI_RAG_EMBED_LIVE=1) ──

// (Live embed + vector-path hybridSearch tests live in __tests__/embedding.live.test.ts —
// that file deliberately doesn't stub globalThis.fetch, matching the
// fork's split between index.test.ts (mocked) and embedding.live.test.ts (real).)

// ─── Storage: loadConfig / saveConfig / ensureDir ───────────────────────────
//
// These tests mutate process.env.PI_RAG_DIR before importing index.ts, which
// means they need a fresh module instance (the env vars are read into
// module-top-level `const`s). `vi.resetModules()` invalidates the cached
// graph so the dynamic import re-evaluates.

describe("Storage (loadConfig / saveConfig)", () => {
  let ragDir: string;
  // Bound at beforeAll-time via fresh module import.
  let loadConfig: typeof import("../index.ts").loadConfig;
  let saveConfig: typeof import("../index.ts").saveConfig;

  beforeAll(async () => {
    ragDir = mkdtempSync(join(tmpdir(), "pi-rag-storage-"));
    process.env.PI_RAG_DIR = ragDir;
    rmSync(ragDir, { recursive: true, force: true });

    vi.resetModules();
    const mod = await import("../index.ts");
    ({ loadConfig, saveConfig } = mod);
  });

  afterAll(() => {
    rmSync(ragDir, { recursive: true, force: true });
    delete process.env.PI_RAG_DIR;
  });

  it("loadConfig: returns defaults when no config file exists", () => {
    const cfg = loadConfig();
    expect(cfg.ragEnabled).toBe(true);
    expect(cfg.ragTopK).toBe(5);
    expect(cfg.ragScoreThreshold).toBe(0.1);
    expect(cfg.ragAlpha).toBe(0.4);
    expect(cfg.extraExtensions).toEqual([]);
    expect(cfg.excludeExtensions).toEqual([]);
    expect(cfg.trackedPaths).toEqual([]);
    expect(cfg.excludePatterns).toEqual([]);
  });

  it("saveConfig / loadConfig round-trip persists every field", () => {
    const written = {
      ragEnabled: false,
      ragTopK: 12,
      ragScoreThreshold: 0.25,
      ragAlpha: 0.7,
      extraExtensions: [".cs", ".tex"],
      excludeExtensions: [".md"],
      trackedPaths: ["/tmp/proj-a", "/tmp/proj-b"],
      excludePatterns: ["*.log", "node_modules/"],
    };
    saveConfig(written);
    expect(loadConfig()).toEqual(written);
    expect(existsSync(join(ragDir, "config.json"))).toBe(true);
    const raw = JSON.parse(readFileSync(join(ragDir, "config.json"), "utf-8"));
    expect(raw).toEqual(written);
  });

  it("loadConfig: merges saved partial config over defaults", () => {
    mkdirSync(ragDir, { recursive: true });
    writeFileSync(join(ragDir, "config.json"), JSON.stringify({ ragTopK: 99 }));
    const cfg = loadConfig();
    expect(cfg.ragTopK).toBe(99);
    expect(cfg.ragEnabled).toBe(true);
    expect(cfg.ragAlpha).toBe(0.4);
  });

  it("loadConfig: malformed JSON falls back to defaults instead of throwing", () => {
    writeFileSync(join(ragDir, "config.json"), "{not valid json");
    const cfg = loadConfig();
    expect(cfg.ragEnabled).toBe(true);
    expect(cfg.ragTopK).toBe(5);
  });
});

// ─── getRagDir: walk-up resolution + project vs global store ────────────────

describe("getRagDir (per-project store resolution)", () => {
  let fakeHome: string;
  let projectRoot: string;
  let savedCwd: string;
  let savedHome: string | undefined;
  let savedUserProfile: string | undefined;
  let savedRagDir: string | undefined;
  let getRagDir: typeof import("../index.ts").getRagDir;
  let GLOBAL_RAG_DIR: typeof import("../index.ts").GLOBAL_RAG_DIR;

  // macOS resolves /var/folders/... → /private/var/folders/... through symlink.
  // mkdtempSync returns one form; process.cwd() after chdir returns the realpath.
  // Use the resolved form everywhere for stable comparisons.
  const resolveTmp = (p: string) => realpathSync(p);

  beforeAll(async () => {
    fakeHome = resolveTmp(mkdtempSync(join(tmpdir(), "pi-rag-home-")));
    projectRoot = resolveTmp(mkdtempSync(join(tmpdir(), "pi-rag-proj-")));
    savedCwd = process.cwd();
    savedHome = process.env.HOME;
    savedUserProfile = process.env.USERPROFILE;
    savedRagDir = process.env.PI_RAG_DIR;
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome;   // os.homedir() on Windows reads USERPROFILE, not HOME
    delete process.env.PI_RAG_DIR;

    vi.resetModules();
    ({ getRagDir, GLOBAL_RAG_DIR } = await import("../index.ts"));
  });

  afterAll(() => {
    process.chdir(savedCwd);
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
    if (savedHome !== undefined) process.env.HOME = savedHome; else delete process.env.HOME;
    if (savedUserProfile !== undefined) process.env.USERPROFILE = savedUserProfile; else delete process.env.USERPROFILE;
    if (savedRagDir !== undefined) process.env.PI_RAG_DIR = savedRagDir;
  });

  it("$PI_RAG_DIR override wins over everything", () => {
    const override = resolveTmp(mkdtempSync(join(tmpdir(), "pi-rag-override-")));
    process.env.PI_RAG_DIR = override;
    try {
      expect(getRagDir()).toBe(override);
    } finally {
      delete process.env.PI_RAG_DIR;
      rmSync(override, { recursive: true, force: true });
    }
  });

  it("returns ${cwd}/.pi/rag when one exists at cwd", () => {
    const projectStore = join(projectRoot, ".pi", "rag");
    mkdirSync(projectStore, { recursive: true });
    process.chdir(projectRoot);
    expect(getRagDir()).toBe(projectStore);
  });

  it("walks up to find a parent .pi/rag", () => {
    const sub = join(projectRoot, "src", "deep");
    mkdirSync(sub, { recursive: true });
    process.chdir(sub);
    expect(getRagDir()).toBe(join(projectRoot, ".pi", "rag"));
  });

  it("falls back to the global ~/.pi/rag when no project store is in scope", () => {
    // Anchor the test cwd inside fakeHome so walk-up actually reaches home
    // (otherwise it walks past tmpdir() and discovers the developer's real
    // ~/.pi/rag on Windows).
    const isolated = resolveTmp(mkdtempSync(join(fakeHome, "iso-")));
    try {
      process.chdir(isolated);
      const got = getRagDir();
      expect(got).toBe(GLOBAL_RAG_DIR());
      expect(got.startsWith(fakeHome)).toBe(true);
    } finally {
      process.chdir(savedCwd);   // Windows refuses rmSync of the cwd
      rmSync(isolated, { recursive: true, force: true });
    }
  });

  it("createIfMissing: anchors a new project store at cwd", () => {
    const fresh = resolveTmp(mkdtempSync(join(fakeHome, "fresh-")));
    try {
      process.chdir(fresh);
      const got = getRagDir({ createIfMissing: true });
      expect(got).toBe(join(fresh, ".pi", "rag"));
      expect(existsSync(got)).toBe(true);
    } finally {
      process.chdir(savedCwd);   // Windows refuses rmSync of the cwd
      rmSync(fresh, { recursive: true, force: true });
    }
  });
});

// ─── isIndexStale ───────────────────────────────────────────────────────────

// ─── isIndexStale ───────────────────────────────────────────────────────────

import { isIndexStale } from "../index.ts";

describe("isIndexStale", () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const fresh = () => new Date(Date.now() - 60_000).toISOString();
  const stale = () => new Date(Date.now() - DAY_MS - 1_000).toISOString();

  it("returns false when lastBuild is empty", () => {
    expect(isIndexStale({ chunks: [], files: {}, lastBuild: "" })).toBe(false);
  });

  it("returns false when index was built recently", () => {
    expect(isIndexStale({ chunks: [], files: {}, lastBuild: fresh() })).toBe(false);
  });

  it("returns true when lastBuild is more than 24 h ago", () => {
    expect(isIndexStale({ chunks: [], files: {}, lastBuild: stale() })).toBe(true);
  });

  it("respects a custom maxAgeMs", () => {
    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1_000).toISOString();
    expect(isIndexStale({ chunks: [], files: {}, lastBuild: tenMinAgo }, 5 * 60 * 1_000)).toBe(true);
    expect(isIndexStale({ chunks: [], files: {}, lastBuild: tenMinAgo }, 15 * 60 * 1_000)).toBe(false);
  });
});

// ─── before_agent_start auto-refresh ────────────────────────────────────────
//
// Exercises the 24h auto-refresh path. The fetch stub in beforeAll above
// returns immediately, so the embed step is fast. PI_RAG_DIR pins storage to
// a throwaway dir so the hook can mutate the on-disk index without touching
// the developer's real ~/.pi/rag.

describe("before_agent_start: 24h auto-refresh", () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  let ragDir: string;
  let cwdSandbox: string;
  let savedCwd: string;
  let savedRagDir: string | undefined;
  let mod: typeof import("../index.ts");
  let extensionFactory: typeof import("../index.ts").default;

  function makePi() {
    let hookFn: ((event: any, ctx: any) => Promise<any>) | undefined;
    const pi = {
      on: (event: string, fn: any) => { if (event === "before_agent_start") hookFn = fn; },
      registerCommand: () => {},
      registerTool: () => {},
      sendMessage: () => {},
    };
    const fire = (event = { prompt: "hello world", systemPrompt: "" }) => hookFn!(event, {});
    return { pi, fire };
  }

  /** Write a single chunk + file row + lastBuild directly into the DB. */
  function seedIndex(opts: { filePath: string; lastBuild: string; fileHash?: string }) {
    const db = mod.getFreshDbConn();
    try {
      // Clear so each test starts clean.
      db.exec(`DELETE FROM chunks_vec; DELETE FROM chunks; DELETE FROM files; DELETE FROM metadata;`);
      const r = db.prepare(`
        INSERT INTO chunks(id, file_path, chunk_content, line_start, line_end, chunk_hash, indexed_at, tokens)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run("test-1", opts.filePath, "const x = 1;", 1, 1, "abc", opts.lastBuild, 5);
      const vec = new Float32Array(384).fill(0.1);
      db.prepare("INSERT INTO chunks_vec(rowid, embedding) VALUES (CAST(? AS INTEGER), ?)").run(
        Number(r.lastInsertRowid),
        Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength),
      );
      db.prepare(`
        INSERT OR REPLACE INTO files(path, hash, chunks, indexed, size, embedded)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(opts.filePath, opts.fileHash ?? "old", 1, opts.lastBuild, 10, 1);
      db.prepare("INSERT OR REPLACE INTO metadata(key, value) VALUES ('last_build', ?)").run(opts.lastBuild);
    } finally {
      db.close();
    }
  }

  function readLastBuild(): string {
    const db = mod.getFreshDbConn();
    try {
      const row = db.prepare("SELECT value FROM metadata WHERE key='last_build'").get() as { value?: string } | undefined;
      return row?.value ?? "";
    } finally {
      db.close();
    }
  }

  beforeAll(async () => {
    ragDir = realpathSync(mkdtempSync(join(tmpdir(), "pi-rag-refresh-")));
    cwdSandbox = realpathSync(mkdtempSync(join(tmpdir(), "pi-rag-refresh-cwd-")));
    savedCwd = process.cwd();
    savedRagDir = process.env.PI_RAG_DIR;
    process.env.PI_RAG_DIR = ragDir;
    process.chdir(cwdSandbox);

    vi.resetModules();
    mod = await import("../index.ts");
    extensionFactory = mod.default;
  });

  afterAll(() => {
    process.chdir(savedCwd);
    rmSync(ragDir, { recursive: true, force: true });
    rmSync(cwdSandbox, { recursive: true, force: true });
    if (savedRagDir !== undefined) process.env.PI_RAG_DIR = savedRagDir;
    else delete process.env.PI_RAG_DIR;
  });

  it("does not update last_build when index is fresh", async () => {
    const freshBuild = new Date(Date.now() - 60_000).toISOString();
    seedIndex({ filePath: "/some/file.ts", lastBuild: freshBuild });
    const { pi, fire } = makePi();
    extensionFactory(pi as any);
    await fire();
    expect(readLastBuild()).toBe(freshBuild);
  });

  it("updates last_build when index is stale and files exist on disk", async () => {
    const testFile = join(cwdSandbox, "sample.ts");
    writeFileSync(testFile, "export const answer = 42;\n");
    const staleBuild = new Date(Date.now() - DAY_MS - 1_000).toISOString();
    seedIndex({ filePath: testFile, lastBuild: staleBuild });
    const { pi, fire } = makePi();
    extensionFactory(pi as any);
    await fire();
    expect(new Date(readLastBuild()).getTime()).toBeGreaterThan(new Date(staleBuild).getTime());
  });

  it("does not update last_build when stale but all referenced files are gone", async () => {
    const staleBuild = new Date(Date.now() - DAY_MS - 1_000).toISOString();
    const missingFile = join(cwdSandbox, "deleted.ts");
    seedIndex({ filePath: missingFile, lastBuild: staleBuild });
    const { pi, fire } = makePi();
    extensionFactory(pi as any);
    await fire();
    expect(readLastBuild()).toBe(staleBuild);
  });
});

// ─── getFreshDbConn: [Symbol.dispose] support ────────────────────────────────
//
// These tests verify the `using` declaration works with getFreshDbConn() and
// that the connection is automatically closed when the block scope exits —
// including the exception path. This is the C# `using` / Java try-with-resources
// pattern, adapted for TypeScript.
describe("getFreshDbConn: [Symbol.dispose] for `using` declaration", () => {
  let mod: typeof import("../index.ts");

  beforeAll(async () => {
    mod = await import("../index.ts");
  });

  it("attaches [Symbol.dispose] to the returned connection", () => {
    using db = mod.getFreshDbConn();
    expect(typeof db[Symbol.dispose]).toBe("function");
  });

  it("closes the connection when the `using` block exits normally", () => {
    let captured: ReturnType<typeof mod.getFreshDbConn> | null = null;
    {
      using db = mod.getFreshDbConn();
      captured = db;
      // Connection is open and usable inside the block.
      expect(db.prepare("SELECT 1 as one").get()).toEqual({ one: 1 });
    }
    // After the block, the connection must be closed.
    expect(() => captured!.prepare("SELECT 1").get()).toThrow(/not open|database/i);
  });

  it("closes the connection even when an exception is thrown inside the block", () => {
    let captured: ReturnType<typeof mod.getFreshDbConn> | null = null;
    expect(() => {
      {
        using db = mod.getFreshDbConn();
        captured = db;
        throw new Error("boom");
      }
    }).toThrow("boom");
    // The dispose ran via the `using` machinery despite the throw.
    expect(() => captured!.prepare("SELECT 1").get()).toThrow(/not open|database/i);
  });

  it("returned object is the same Database instance (mutated, not copied)", () => {
    using db = mod.getFreshDbConn();
    // prepare() is a prototype method on better-sqlite3 Database; the
    // Object.assign wrapper preserves them all.
    expect(typeof db.prepare).toBe("function");
    expect(typeof db.close).toBe("function");
    expect(typeof db.pragma).toBe("function");
  });
});
