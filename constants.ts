// ANSI color escapes — used by stderr progress lines and TUI widgets in
// callers that don't have access to ctx.ui.theme.
export const RST = "\x1b[0m", B = "\x1b[1m", D = "\x1b[2m";
export const GREEN = "\x1b[32m", YELLOW = "\x1b[33m", CYAN = "\x1b[36m", RED = "\x1b[31m", MAGENTA = "\x1b[35m";

// Embedding backend — the actual embedding model is configured at runtime
// via RagConfig.embeddingModel / PI_RAG_EMBED_MODEL (see embedConfig.ts).
// This constant is just the fallback default.
export const DEFAULT_EMBED_MODEL = "nomic-embed-text";

export const DEFAULT_TEXT_EXTS = [
  ".md", ".mdx", ".txt", ".rst",
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".rs", ".go", ".java", ".kt", ".kts", ".scala",
  ".c", ".cc", ".cpp", ".cxx", ".h", ".hpp", ".hxx",
  ".cs", ".fs", ".vb",
  ".swift", ".m", ".mm",
  ".rb", ".php", ".pl", ".lua", ".dart", ".ex", ".exs", ".erl", ".clj", ".cljs", ".edn",
  ".vue", ".svelte", ".astro",
  ".css", ".scss", ".sass", ".less",
  ".html", ".htm",
  ".json", ".jsonc", ".yaml", ".yml", ".toml", ".ini", ".xml", ".csv", ".tsv",
  ".sh", ".bash", ".zsh", ".fish", ".ps1",
  ".sql", ".graphql", ".gql", ".proto",
  ".env", ".gitignore", ".dockerfile", ".tf", ".hcl",
];

export const BINARY_DOC_EXTS = new Set([".pdf", ".docx"]);

export const TEXT_MAX_BYTES = 500_000;
export const BINARY_DOC_MAX_BYTES = 10_000_000;

export const SKIP_DIRS = new Set([
  "node_modules", ".git", ".next", "dist", "build", "__pycache__", ".venv", "venv", ".cache",
]);
