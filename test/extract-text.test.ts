import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { extractText } from "../index.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SAMPLE_PDF = readFileSync(join(__dirname, "fixtures", "sample.pdf"));

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

test("extractText: reads plain text files as utf-8", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "rag-extract-"));
  try {
    const fp = join(tmp, "a.txt");
    writeFileSync(fp, "hello world");
    const { text, hash, size } = await extractText(fp);
    assert.equal(text, "hello world");
    assert.match(hash, /^[0-9a-f]{12}$/);
    assert.equal(size, 11);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("extractText: extracts text from a .pdf", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "rag-extract-"));
  try {
    const fp = join(tmp, "a.pdf");
    writeFileSync(fp, SAMPLE_PDF);
    const { text, hash, size } = await extractText(fp);
    assert.ok(text.includes("RagPdfMarker"), "expected RagPdfMarker in extracted text");
    assert.match(hash, /^[0-9a-f]{12}$/);
    assert.equal(size, SAMPLE_PDF.length);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("extractText: extracts text from a .docx", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "rag-extract-"));
  try {
    const fp = join(tmp, "a.docx");
    writeFileSync(fp, await buildMinimalDocx("RagDocxMarker"));
    const { text } = await extractText(fp);
    assert.ok(text.includes("RagDocxMarker"), "expected RagDocxMarker in extracted text");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("extractText: silences pdfjs Warning/Info console output during PDF parse", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "rag-extract-"));
  try {
    const fp = join(tmp, "loud.pdf");
    writeFileSync(fp, SAMPLE_PDF);
    const leaked: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => {
      const first = args[0];
      if (typeof first === "string" && /^(Warning|Info|Deprecated API usage):/.test(first)) {
        leaked.push(first);
      }
      // intentionally drop everything during the test to keep test output clean
    };
    try {
      const r = await extractText(fp);
      assert.ok(r.text.includes("RagPdfMarker"), "text extraction must still work");
    } finally {
      console.log = origLog;
    }
    assert.equal(leaked.length, 0, `expected 0 pdfjs warnings, got ${leaked.length}: ${leaked.slice(0, 3).join(" | ")}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("extractText: hash is stable across reads of the same binary file (skip-on-rebuild)", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "rag-extract-"));
  try {
    const fp = join(tmp, "stable.pdf");
    writeFileSync(fp, SAMPLE_PDF);
    const a = await extractText(fp);
    const b = await extractText(fp);
    assert.equal(a.hash, b.hash);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
