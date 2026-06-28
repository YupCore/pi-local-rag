import { basename } from "node:path";
import Database from "better-sqlite3";
import { getDbConn, float32ToBuffer, type IndexStats } from "./db.ts";
import { embedBatch, getVectorDim } from "./embed.ts";
import { resolveEmbedConfig } from "./embedConfig.ts";
import { loadConfig } from "./config.ts";
import { chunkText, extractText, sha256 } from "./chunking.ts";

export interface ProgressCallbacks {
  onFile?: (current: number, total: number, filename: string, skipped: number) => void;
  onChunk?: (fileChunk: number, totalChunks: number, filename: string) => void;
  /** Fires after each cross-file embed micro-batch completes. `done` is the
   *  number of chunks embedded so far across all files; `total` is the grand
   *  total. Used by the TUI to render live embedding progress instead of
   *  freezing at "Rebuilding 100%". */
  onEmbed?: (done: number, total: number) => void;
  onSave?: () => void;
}

export function isIndexStale(index: IndexStats, maxAgeMs = 24 * 60 * 60 * 1000): boolean {
  if (!index.lastBuild) return false;
  return Date.now() - new Date(index.lastBuild).getTime() > maxAgeMs;
}

const yield_ = () => new Promise<void>(r => setTimeout(r, 0));

let _suppressStderr = false;

function stderrProgress(msg: string) {
  if (_suppressStderr) return;
  process.stderr.write(`\r\x1b[2K${msg}`);
}

interface FileWork {
  fp: string;
  hash: string;
  size: number;
  rawChunks: { content: string; lineStart: number; lineEnd: number; hash: string; part: number }[];
  _vectors?: number[][];
}

export async function indexFiles(
  paths: string[],
  progress?: ProgressCallbacks,
  _db?: Database.Database,
  force?: boolean,
): Promise<{ indexed: number; chunks: number; skipped: number; durationMs: number }> {
  const hadCallbacks = !!progress;
  if (hadCallbacks) _suppressStderr = true;
  const database = _db ?? getDbConn();
  const startMs = Date.now();
  const total = paths.length;

  try {
    if (total === 0) {
      return { indexed: 0, chunks: 0, skipped: 0, durationMs: Date.now() - startMs };
    }

    const getFileStmt = database.prepare("SELECT hash, embedded FROM files WHERE path = ?");
    const delChunks = database.prepare("DELETE FROM chunks WHERE file_path = ?");
    const delVec = database.prepare("DELETE FROM chunks_vec WHERE rowid IN (SELECT rowid FROM chunks WHERE file_path = ?)");

    // Phase 1: parallel read + chunk; DB ops on main thread
    const CONCURRENCY = 32;
    const YIELD_INTERVAL = 64;

    interface ReadResult { fp: string; hash: string; size: number; raw: { content: string; lineStart: number; lineEnd: number; part: number }[] }

    const readQueue: ReadResult[] = [];
    let readQueueDone = false;
    let readErrorCount = 0;
    let resolveRead: (() => void) | null = null;
    const notifyRead = () => { resolveRead?.(); resolveRead = null; };
    const waitRead = () => new Promise<void>(r => { resolveRead = r; });

    const workerCount = Math.min(CONCURRENCY, paths.length);
    let pathsIdx = 0;
    let producersDone = 0;
    const producers: Promise<void>[] = [];
    for (let w = 0; w < workerCount; w++) {
      producers.push((async () => {
        while (true) {
          const i = pathsIdx++;
          if (i >= paths.length) { producersDone++; if (producersDone >= workerCount) { readQueueDone = true; notifyRead(); } return; }
          try {
            const { text, hash, size } = await extractText(paths[i]);
            const raw = chunkText(text);
            readQueue.push({ fp: paths[i], hash, size, raw });
            notifyRead();
          } catch {
            readErrorCount++;
            stderrProgress(`[${i + 1}/${total}] ERROR ${basename(paths[i])}: not found or unreadable`);
          }
        }
      })());
    }

    const toIndex: FileWork[] = [];
    let skipped = 0;
    let processedCount = 0;
    let nextYieldAt = 0;

    const drainReads = () => {
      while (readQueue.length > 0) {
        const r = readQueue.shift()!;
        processedCount++;
        const name = basename(r.fp);

        const existing = getFileStmt.get(r.fp) as { hash?: string; embedded?: number } | undefined;
        if (!force && existing?.hash === r.hash && existing?.embedded) {
          skipped++;
          progress?.onFile?.(processedCount, total, name, skipped);
          continue;
        }

        delVec.run(r.fp);
        delChunks.run(r.fp);

        const rawChunks = r.raw.map(c => ({ ...c, hash: sha256(c.content) }));
        stderrProgress(`[${processedCount}/${total}] chunked ${name} (${rawChunks.length} chunks)`);
        progress?.onFile?.(processedCount, total, name, skipped);

        toIndex.push({ fp: r.fp, hash: r.hash, size: r.size, rawChunks });
      }
    };

    const maybeYield = async () => {
      if (processedCount >= nextYieldAt) {
        nextYieldAt = processedCount + YIELD_INTERVAL;
        await yield_();
      }
    };

    while (!readQueueDone || readQueue.length > 0) {
      drainReads();
      if (!readQueueDone) await waitRead();
      await maybeYield();
    }
    drainReads();
    await yield_();

    skipped += readErrorCount;

    // Phase 2: embed in cross-file groups with bounded concurrency.
    // Each group is one HTTP POST with up to batchSize inputs (from config or
    // the embed.ts default). Multiple groups fly in parallel — the wall-time
    // win scales with EMBED_CONCURRENCY up to the server's throughput.
    // 3 is a safe ceiling for a single-process llama.cpp server; raise for
    // hosted endpoints (OpenAI handles 10+ easily).
    const resolvedCfg = resolveEmbedConfig(loadConfig());
    const EMBED_GROUP_TARGET = resolvedCfg.batchSize ?? 64;
    const EMBED_CONCURRENCY = resolvedCfg.concurrency ?? 3;

    interface GroupJob {
      texts: string[];
      targets: { fw: FileWork; ci: number }[];
    }

    // Pre-build all groups so the worker pool knows exactly what to fetch.
    const allGroups: GroupJob[] = [];
    for (const fw of toIndex) {
      for (let j = 0; j < fw.rawChunks.length; j++) {
        let group = allGroups[allGroups.length - 1];
        if (!group || group.texts.length >= EMBED_GROUP_TARGET) {
          group = { texts: [], targets: [] };
          allGroups.push(group);
        }
        group.texts.push(fw.rawChunks[j].content);
        group.targets.push({ fw, ci: j });
      }
    }

    const totalChunks = allGroups.reduce((s, g) => s + g.texts.length, 0);

    // Pool of workers — each grabs the next pending group index, runs embedBatch,
    // writes its vectors into the matching file's _vectors slot. Workers
    // interleave naturally via awaits; nextGroup is shared but JS is single-
    // threaded so its increment is atomic.
    let completedChunks = 0;
    let nextGroup = 0;
    async function worker(): Promise<void> {
      while (true) {
        const i = nextGroup++;
        if (i >= allGroups.length) return;
        const group = allGroups[i];
        const vectors = await embedBatch(group.texts);
        for (let vi = 0; vi < group.targets.length; vi++) {
          const t = group.targets[vi];
          t.fw._vectors ??= new Array(t.fw.rawChunks.length);
          t.fw._vectors[t.ci] = vectors[vi];
        }
        completedChunks += group.texts.length;
        stderrProgress(`Embedding ${completedChunks}/${totalChunks} chunks`);
        progress?.onEmbed?.(completedChunks, totalChunks);
        // Yield so the TUI can render the progress update between batches.
        await yield_();
      }
    }

    const poolSize = Math.min(EMBED_CONCURRENCY, allGroups.length);
    await Promise.all(Array.from({ length: poolSize }, () => worker()));

    // Phase 3: insert chunks + vectors into DB
    const insChunk = database.prepare(`
      INSERT INTO chunks(id, file_path, chunk_content, line_start, line_end, chunk_hash, indexed_at, tokens)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insVecRowid = database.prepare("INSERT INTO chunks_vec(rowid, embedding) VALUES (CAST(? AS INTEGER), ?)");
    const upsertFile = database.prepare(`
      INSERT INTO files(path, hash, chunks, indexed, size, embedded)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        hash=excluded.hash, chunks=excluded.chunks, indexed=excluded.indexed,
        size=excluded.size, embedded=excluded.embedded
    `);

    let chunked = 0;
    const indexedAt = new Date().toISOString();
    const tx = database.transaction(() => {
      for (const fw of toIndex) {
        const vectors = fw._vectors;
        // Hash the file path once per file — every chunk id embeds it.
        // part disambiguates within a file (continuation chunks of a single
        // oversized line share lineStart but need unique ids).
        const fpHash = sha256(fw.fp);
        for (let j = 0; j < fw.rawChunks.length; j++) {
          const c = fw.rawChunks[j];
          const chunkResult = insChunk.run(
            `${fpHash}-${c.lineStart}-${c.part}`,
            fw.fp, c.content, c.lineStart, c.lineEnd, c.hash,
            indexedAt,
            Math.ceil(c.content.length / 4),
          );
          if (vectors?.[j]) {
            insVecRowid.run(Number(chunkResult.lastInsertRowid), float32ToBuffer(vectors[j]));
          }
          chunked++;
        }
        upsertFile.run(fw.fp, fw.hash, fw.rawChunks.length, indexedAt, fw.size, 1);
      }
    });

    tx();

    if (!hadCallbacks) process.stderr.write(`\r\x1b[2K`);
    progress?.onSave?.();
    const metaTx = database.transaction(() => {
      database.prepare("INSERT OR REPLACE INTO metadata(key, value) VALUES ('last_build', ?)").run(new Date().toISOString());
      database.prepare("INSERT OR REPLACE INTO metadata(key, value) VALUES ('embedding_model', ?)").run(resolvedCfg.model);
      database.prepare("INSERT OR REPLACE INTO metadata(key, value) VALUES ('vector_dim', ?)").run(String(getVectorDim()));
    });
    metaTx();

    return { indexed: toIndex.length, chunks: chunked, skipped, durationMs: Date.now() - startMs };
  } finally {
    if (hadCallbacks) _suppressStderr = false;
  }
}
