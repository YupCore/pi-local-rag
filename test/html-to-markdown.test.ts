import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { extractText } from "../index.ts";

function setup() {
  return mkdtempSync(join(tmpdir(), "rag-html-"));
}

test("extractText HTML: converts simple HTML to markdown", async () => {
  const tmp = setup();
  try {
    const fp = join(tmp, "simple.html");
    writeFileSync(fp, "<p>Hello <strong>world</strong></p>");
    const { text } = await extractText(fp);
    assert.ok(text.includes("Hello"));
    assert.ok(text.includes("world"));
    assert.ok(!text.includes("<p>"));
    assert.ok(!text.includes("<strong>"));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("extractText HTML: removes script and style blocks", async () => {
  const tmp = setup();
  try {
    const fp = join(tmp, "no-script.html");
    writeFileSync(fp, "<p>Before</p><script>alert('xss')</script><style>.x{}</style><p>After</p>");
    const { text } = await extractText(fp);
    assert.ok(text.includes("Before"));
    assert.ok(text.includes("After"));
    assert.ok(!text.includes("alert"));
    assert.ok(!text.includes(".x{}"));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("extractText HTML: removes nav and footer elements", async () => {
  const tmp = setup();
  try {
    const fp = join(tmp, "no-nav.html");
    writeFileSync(fp, "<nav>Home | About</nav><p>Content</p><footer>Copyright</footer>");
    const { text } = await extractText(fp);
    assert.ok(text.includes("Content"));
    assert.ok(!text.includes("Home | About"));
    assert.ok(!text.includes("Copyright"));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("extractText HTML: converts headings to atx style", async () => {
  const tmp = setup();
  try {
    const fp = join(tmp, "headings.html");
    writeFileSync(fp, "<h1>Title</h1><h2>Subtitle</h2><p>Body</p>");
    const { text } = await extractText(fp);
    assert.ok(text.includes("# Title"));
    assert.ok(text.includes("## Subtitle"));
    assert.ok(text.includes("Body"));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("extractText HTML: fences code blocks", async () => {
  const tmp = setup();
  try {
    const fp = join(tmp, "code.html");
    writeFileSync(fp, '<pre><code class="lang-cs">var x = 1;</code></pre>');
    const { text } = await extractText(fp);
    assert.ok(text.includes("```"));
    assert.ok(text.includes("var x = 1;"));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("extractText HTML: converts lists to markdown", async () => {
  const tmp = setup();
  try {
    const fp = join(tmp, "lists.html");
    writeFileSync(fp, "<ul><li>One</li><li>Two</li></ul>");
    const { text } = await extractText(fp);
    assert.ok(text.includes("One"));
    assert.ok(text.includes("Two"));
    assert.ok(!text.includes("<li>"));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("extractText HTML: hashes the raw HTML, not the markdown", async () => {
  const tmp = setup();
  try {
    const fp = join(tmp, "hash-test.html");
    const raw = "<p>Content</p>";
    writeFileSync(fp, raw);
    const { hash, text } = await extractText(fp);
    assert.match(hash, /^[0-9a-f]{12}$/);
    assert.ok(!text.includes("<p>"));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("extractText HTML: handles real-world Unity doc HTML structure", async () => {
  const tmp = setup();
  try {
    const fp = join(tmp, "unity-doc.html");
    const html = `<!DOCTYPE html><html><head><script>var x = 1;</script></head>
<body><nav>Navigation</nav><div class="content"><h1>Add textures to the camera history</h1>
<p>To add your own texture to the <strong>camera</strong> history.</p>
<pre><code>public class Example : CameraHistoryItem { }</code></pre>
<ul><li>Step one</li><li>Step two</li></ul>
</div><footer>Copyright</footer></body></html>`;
    writeFileSync(fp, html);
    const { text } = await extractText(fp);
    assert.ok(text.includes("# Add textures to the camera history"));
    assert.ok(text.includes("camera"));
    assert.ok(text.includes("public class Example : CameraHistoryItem { }"));
    assert.ok(text.includes("Step one"));
    assert.ok(text.includes("Step two"));
    assert.ok(!text.includes("<script>"));
    assert.ok(!text.includes("var x"));
    assert.ok(!text.includes("Navigation"));
    assert.ok(!text.includes("Copyright"));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("extractText HTML: also handles .htm extension", async () => {
  const tmp = setup();
  try {
    const fp = join(tmp, "page.htm");
    writeFileSync(fp, "<h1>Title</h1><p>Body</p>");
    const { text } = await extractText(fp);
    assert.ok(text.includes("# Title"));
    assert.ok(text.includes("Body"));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("extractText HTML: produces much smaller output than raw HTML for Unity docs", async () => {
  const tmp = setup();
  try {
    const fp = join(tmp, "big.html");
    const html = "<script>" + "x".repeat(5000) + "</script>"
      + "<style>" + "y".repeat(3000) + "</style>"
      + "<nav>" + "z".repeat(2000) + "</nav>"
      + "<p>Actual content here about framebuffer fetch</p>"
      + "<footer>" + "w".repeat(1000) + "</footer>";
    writeFileSync(fp, html);
    const { text } = await extractText(fp);
    assert.ok(text.length < html.length / 2);
    assert.ok(text.includes("Actual content here about framebuffer fetch"));
    assert.ok(!text.includes("x".repeat(100)));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
