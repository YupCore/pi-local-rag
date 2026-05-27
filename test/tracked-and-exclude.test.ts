import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectFiles, collectFromTracked, isExcludedByConfig } from "../index.ts";

function makeProj(): string {
  const root = mkdtempSync(join(tmpdir(), "rag-track-"));
  writeFileSync(join(root, "a.ts"), "x");
  writeFileSync(join(root, "b.ts"), "x");
  writeFileSync(join(root, "page.html"), "<p>x</p>");
  mkdirSync(join(root, "gen"));
  writeFileSync(join(root, "gen", "ignored.ts"), "x");
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "deep.ts"), "x");
  return root;
}

test("collectFiles: excludePatterns filters a top-level file", () => {
  const root = makeProj();
  try {
    const files = collectFiles(root, undefined, ["b.ts"]).map(f => f.replace(root, ""));
    assert.ok(!files.includes("/b.ts"), "b.ts should be excluded");
    assert.ok(files.includes("/a.ts"), "a.ts should still be collected");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("collectFiles: excludePatterns filters a whole directory subtree", () => {
  const root = makeProj();
  try {
    const files = collectFiles(root, undefined, ["gen/"]).map(f => f.replace(root, ""));
    assert.ok(!files.some(f => f.includes("/gen/")), "everything under gen/ should be excluded");
    assert.ok(files.includes("/src/deep.ts"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("collectFiles: extension glob exclude", () => {
  const root = makeProj();
  try {
    const files = collectFiles(root, undefined, ["*.html"]).map(f => f.replace(root, ""));
    assert.ok(!files.some(f => f.endsWith(".html")));
    assert.ok(files.some(f => f.endsWith(".ts")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("collectFromTracked: walks every tracked path, dedupes overlaps", () => {
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
    assert.equal(files.filter(f => f.endsWith("x.ts")).length, 1, "duplicate tracked path should not duplicate files");
    assert.ok(files.some(f => f.endsWith("x.ts")));
    assert.ok(files.some(f => f.endsWith("y.ts")));
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});

test("collectFromTracked: silently skips non-existent tracked paths", () => {
  const a = mkdtempSync(join(tmpdir(), "rag-track-a-"));
  try {
    writeFileSync(join(a, "x.ts"), "x");
    const cfg = {
      ragEnabled: true, ragTopK: 5, ragScoreThreshold: 0.1, ragAlpha: 0.4,
      extraExtensions: [], excludeExtensions: [],
      trackedPaths: [a, "/definitely/not/a/real/dir-xyz-123"],
      excludePatterns: [],
    };
    const files = collectFromTracked(cfg);
    assert.equal(files.length, 1);
  } finally {
    rmSync(a, { recursive: true, force: true });
  }
});

test("collectFromTracked: applies excludePatterns per tracked root", () => {
  const root = makeProj();
  try {
    const cfg = {
      ragEnabled: true, ragTopK: 5, ragScoreThreshold: 0.1, ragAlpha: 0.4,
      extraExtensions: [], excludeExtensions: [],
      trackedPaths: [root],
      excludePatterns: ["gen/"],
    };
    const files = collectFromTracked(cfg);
    assert.ok(!files.some(f => f.includes("/gen/")));
    assert.ok(files.some(f => f.endsWith("a.ts")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("isExcludedByConfig: false when no patterns", () => {
  assert.equal(isExcludedByConfig("/repo/a.ts", ["/repo"], []), false);
});

test("isExcludedByConfig: matches a file relative to a root", () => {
  assert.equal(isExcludedByConfig("/repo/gen/x.ts", ["/repo"], ["gen/"]), true);
  assert.equal(isExcludedByConfig("/repo/src/x.ts", ["/repo"], ["gen/"]), false);
});

test("isExcludedByConfig: tries all roots; returns true if any matches", () => {
  assert.equal(
    isExcludedByConfig("/repo-b/gen/x.ts", ["/repo-a", "/repo-b"], ["gen/"]),
    true,
  );
});

test("isExcludedByConfig: file outside every root is not excluded", () => {
  assert.equal(isExcludedByConfig("/elsewhere/a.ts", ["/repo"], ["*.ts"]), false);
});
