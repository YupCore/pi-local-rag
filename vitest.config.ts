import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["__tests__/**/*.test.ts"],
    // embedding.live.test.ts hits a real /v1/embeddings server — opt in
    // explicitly with: npm test -- embedding.live  (and PI_RAG_EMBED_LIVE=1).
    exclude: ["node_modules/**", "dist/**", "**/embedding.live.test.ts"],
    // Several suites set process.env.PI_RAG_DIR before importing index.ts,
    // so running them in parallel would race over the shared module instance.
    // Keep files sequential — runtime is < 1 s.
    fileParallelism: false,
    testTimeout: 10_000,
  },
});
