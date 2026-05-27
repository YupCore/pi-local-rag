import { test } from "node:test";
import assert from "node:assert/strict";
import { relative, basename } from "node:path";
import ignore from "ignore";

// Mirrors the matching loop in the `/rag find` command. Keeps the test focused
// on the glob semantics without booting the full extension/registerCommand path.
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

test("/rag find: matches by extension glob (*.ts)", () => {
  const files = ["/repo/src/a.ts", "/repo/src/b.js", "/repo/test/c.ts", "/repo/README.md"];
  assert.deepEqual(findMatches(files, "*.ts", "/repo"), ["/repo/src/a.ts", "/repo/test/c.ts"]);
});

test("/rag find: matches by basename prefix (page*)", () => {
  const files = ["/repo/page1.html", "/repo/page2.html", "/repo/about.html"];
  assert.deepEqual(findMatches(files, "page*", "/repo"), ["/repo/page1.html", "/repo/page2.html"]);
});

test("/rag find: matches a directory subtree (src/)", () => {
  const files = ["/repo/src/a.ts", "/repo/src/inner/b.ts", "/repo/test/c.ts"];
  const m = findMatches(files, "src", "/repo");
  assert.ok(m.includes("/repo/src/a.ts"));
  assert.ok(m.includes("/repo/src/inner/b.ts"));
  assert.ok(!m.includes("/repo/test/c.ts"));
});

test("/rag find: returns empty when nothing matches", () => {
  const files = ["/repo/a.ts", "/repo/b.md"];
  assert.deepEqual(findMatches(files, "*.py", "/repo"), []);
});

test("/rag find: falls back to basename for files outside cwd", () => {
  const files = ["/elsewhere/notes.md", "/repo/src/a.ts"];
  // From /repo, /elsewhere/notes.md → rel starts with "..", so we match the basename.
  assert.deepEqual(findMatches(files, "notes.md", "/repo"), ["/elsewhere/notes.md"]);
});

test("/rag find: exact filename glob", () => {
  const files = ["/repo/src/foo.js", "/repo/lib/foo.js", "/repo/src/bar.js"];
  const m = findMatches(files, "foo.js", "/repo");
  assert.ok(m.includes("/repo/src/foo.js"));
  assert.ok(m.includes("/repo/lib/foo.js"));
  assert.ok(!m.includes("/repo/src/bar.js"));
});
