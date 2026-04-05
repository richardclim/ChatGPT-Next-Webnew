import * as lancedb from "@lancedb/lancedb";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { getServerSideConfig } from "@/app/config/server";
import path from "path";
import fs from "fs";
import { nanoid } from "nanoid";

const DB_PATH = path.join(process.cwd(), "nextchat-data", "vectors");
const TABLE_NAME = "episodic_memory";

export interface MemoryChunk {
  id: string;
  content: string;
  /** All chat sessions whose content contributed to this record. */
  sessionIds: string[];
  createdAt: number;
  /** Timestamp of the very first version of this entry (preserved across updates). */
  originalCreatedAt?: number;
  keywords?: string[]; // Optional, as it's now embedded in content
  // vector is generated server-side if not provided
  vector?: number[];
  replaceEntryId?: string; // If set, directly replace this entry (skip similarity routing)
}



let dbInstance: lancedb.Connection | null = null;
let modelInstance: any = null;

async function getDb() {
  if (!dbInstance) {
    const parentDir = path.dirname(DB_PATH);
    if (!fs.existsSync(parentDir)) {
      // Create nextchat-data if not exists
      fs.mkdirSync(parentDir, { recursive: true });
    }
    // Lancedb connects to a directory (the database)
    dbInstance = await lancedb.connect(DB_PATH);
  }
  return dbInstance;
}

async function getModel() {
  if (!modelInstance) {
    const config = getServerSideConfig();
    const apiKey = config.googleApiKey;
    if (!apiKey) {
      throw new Error("Google API Key is missing");
    }
    const genAI = new GoogleGenerativeAI(apiKey);
    modelInstance = genAI.getGenerativeModel({ model: "gemini-embedding-001" });
  }
  return modelInstance;
}

export async function embedText(text: string): Promise<number[]> {
  const model = await getModel();
  const result = await model.embedContent(text);
  const vector = result.embedding.values;
  return vector;
}

export async function upsertMemory(
  chunks: MemoryChunk[],
  askLLM?: (
    existing: string,
    newContent: string,
  ) => Promise<{
    action: "INSERT" | "MERGE" | "IGNORE";
    mergedContent?: string;
  }>,
): Promise<string | undefined> {
  const db = await getDb();
  const tableNames = await db.tableNames();
  let entryId: string | undefined;

  // Helper to ensure table exists
  let table: lancedb.Table;
  if (!tableNames.includes(TABLE_NAME)) {
    // Initial creation - just insert all without checks (nothing to compare against)
    const data = [];
    for (const chunk of chunks) {
      const { replaceEntryId: _, ...chunkData } = chunk;
      const vector = await embedText(chunk.content);
      const newId = chunk.id || nanoid();
      data.push({
        ...chunkData,
        sessionIds: chunk.sessionIds,
        originalCreatedAt: chunk.originalCreatedAt || chunk.createdAt,
        vector,
        keywords: chunk.keywords || [],
        id: newId,
      });
      entryId = newId;
    }
    table = await db.createTable(TABLE_NAME, data);
    try {
      await table.createIndex("content", { config: lancedb.Index.fts() });
      console.log("[Vector Store] FTS index created on new table");
    } catch (e) {
      console.warn("[Vector Store] Failed to create FTS index on new table", e);
    }
    return entryId;
  }

  table = await db.openTable(TABLE_NAME);

  // Ensure FTS index exists on existing table (may be missing if table was created before FTS support)
  try {
    const indices = await table.listIndices();
    const hasFtsIndex = indices.some(
      (idx) => idx.columns.includes("content") && idx.indexType === "FTS",
    );
    if (!hasFtsIndex) {
      console.log(
        "[Vector Store] FTS index missing on existing table. Creating...",
      );
      await table.createIndex("content", { config: lancedb.Index.fts() });
      console.log("[Vector Store] FTS index created on existing table");
    }
  } catch (e) {
    console.warn(
      "[Vector Store] Failed to check/create FTS index on existing table",
      e,
    );
  }

  // Process chunks individually for smart upsert
  for (const chunk of chunks) {
    const { replaceEntryId, ...chunkData } = chunk;

    // Direct replace path: skip similarity routing entirely
    if (replaceEntryId) {
      // Fetch existing record to carry forward its sessionIds and originalCreatedAt
      let priorSessionIds: string[] = [];
      let priorOriginalCreatedAt: number | undefined;
      try {
        const prior = await table
          .query()
          .where(`id = '${replaceEntryId.replace(/'/g, "''")}'`)
          .limit(1)
          .toArray();
        if (prior.length > 0) {
          priorSessionIds = (prior[0].sessionIds as string[]) || [];
          priorOriginalCreatedAt =
            (prior[0].originalCreatedAt as number) ||
            (prior[0].createdAt as number);
        }
        await table.delete(`id = '${replaceEntryId}'`);
        console.log(
          `[Memory Router] Deleted existing entry: ${replaceEntryId}`,
        );
      } catch (e) {
        console.warn(
          `[Memory Router] Could not delete entry ${replaceEntryId} (may not exist)`,
          e,
        );
      }
      const mergedSessionIds = [
        ...new Set([...priorSessionIds, ...chunk.sessionIds]),
      ];
      const newVector = await embedText(chunk.content);
      const newId = nanoid();
      await table.add([
        {
          ...chunkData,
          sessionIds: mergedSessionIds,
          originalCreatedAt:
            priorOriginalCreatedAt ||
            chunk.originalCreatedAt ||
            chunk.createdAt,
          vector: newVector,
          keywords: chunk.keywords || [],
          id: newId,
        },
      ]);
      console.log(
        `[Memory Router] Direct replace complete. New entry: ${newId}`,
      );
      entryId = newId;
      continue;
    }

    const vector = await embedText(chunk.content);
    const newVector = vector;
    const newContent = chunk.content;

    // 1. Search for existing similar memories
    // We only compare against the single most similar chunk
    // Using cosine distance: similarity = 1 - distance, where distance ∈ [0, 2]
    const searchResults = await table
      .vectorSearch(newVector)
      .distanceType("cosine")
      .limit(1)
      .toArray();

    const existing = searchResults.length > 0 ? searchResults[0] : null;

    // Cosine distance ranges [0, 2], so similarity = 1 - distance gives a theoretical range of [-1, 1].
    // For normalized text embeddings, similarity typically ranges [0, 1]
    let similarity = 0;
    if (existing) {
      similarity = 1 - (existing._distance || 0);
    }

    console.log(`[Memory Router] Similarity score: ${similarity}`);

    const SIMILARITY_THRESHOLD_LOWER = 0.8;
    const SIMILARITY_THRESHOLD_UPPER = 0.99;

    // CASE A: Not similar enough. It's a new topic.
    if (!existing || similarity < SIMILARITY_THRESHOLD_LOWER) {
      console.log("[Memory Router] Low similarity. Inserting as new.");
      const newId = chunk.id || nanoid();
      await table.add([
        {
          ...chunkData,
          sessionIds: chunk.sessionIds,
          originalCreatedAt: chunk.originalCreatedAt || chunk.createdAt,
          vector: newVector,
          keywords: chunk.keywords || [],
          id: newId,
        },
      ]);
      entryId = newId;
      continue;
    }

    // CASE B: Exact Duplicate.
    if (similarity > SIMILARITY_THRESHOLD_UPPER) {
      console.log("[Memory Router] Exact duplicate detected. Ignoring.");
      continue;
    }

    // CASE C: Ambiguous. Ask LLM.
    if (askLLM) {
      console.log("[Memory Router] Ambiguous similarity. Asking LLM to route.");
      try {
        const decision = await askLLM(existing.content, newContent);

        if (decision.action === "INSERT") {
          const newId = chunk.id || nanoid();
          await table.add([
            {
              ...chunkData,
              sessionIds: chunk.sessionIds,
              originalCreatedAt: chunk.originalCreatedAt || chunk.createdAt,
              vector: newVector,
              keywords: chunk.keywords || [],
              id: newId,
            },
          ]);
          entryId = newId;
        } else if (decision.action === "MERGE" && decision.mergedContent) {
          // Union session IDs from both records so we preserve full lineage
          const existingSessionIds = (existing.sessionIds as string[]) || [];
          const mergedSessionIds = [
            ...new Set([...existingSessionIds, ...chunk.sessionIds]),
          ];
          await table.delete(`id = '${existing.id}'`);
          const mergedVector = await embedText(decision.mergedContent);
          const existingKeywords: string[] = existing.keywords || [];
          const newKeywords: string[] = chunk.keywords || [];
          const mergedKeywords = [
            ...new Set([...existingKeywords, ...newKeywords]),
          ];
          const existingOriginal =
            (existing.originalCreatedAt as number) ||
            (existing.createdAt as number);
          await table.add([
            {
              id: existing.id,
              content: decision.mergedContent,
              sessionIds: mergedSessionIds,
              createdAt: Date.now(),
              originalCreatedAt: existingOriginal,
              keywords: mergedKeywords,
              vector: mergedVector,
            },
          ]);
          entryId = existing.id;
        } else if (decision.action === "IGNORE") {
          console.log("[Memory Router] LLM decided to IGNORE.");
        } else {
          // Unexpected response - log a warning
          console.warn(
            `[Memory Router] Unexpected LLM action: ${decision.action}. Ignoring.`,
          );
        }
      } catch (e) {
        console.error(
          "[Memory Router] LLM decision failed. Fallback to INSERT.",
          e,
        );
        const fallbackId = chunk.id || nanoid();
        await table.add([
          {
            ...chunkData,
            sessionIds: chunk.sessionIds,
            originalCreatedAt: chunk.originalCreatedAt || chunk.createdAt,
            vector: newVector,
            keywords: chunk.keywords || [],
            id: fallbackId,
          },
        ]);
        entryId = fallbackId;
      }
    } else {
      // Fallback if no LLM provided (should not happen in new flow, but good for safety)
      console.log("[Memory Router] No LLM provider. Defaulting to INSERT.");
      const fallbackId = chunk.id || nanoid();
      await table.add([
        {
          ...chunkData,
          sessionIds: chunk.sessionIds,
          originalCreatedAt: chunk.originalCreatedAt || chunk.createdAt,
          vector: newVector,
          keywords: chunk.keywords || [],
          id: fallbackId,
        },
      ]);
      entryId = fallbackId;
    }
  }

  return entryId;
}

/**
 * Strip the embedded `Keywords: ...` line from stored content.
 * Keywords are baked into `content` to boost search/embedding relevance
 * but should not be surfaced to LLMs or the UI.
 */
export function stripKeywordsLine(content: string): string {
  return content.replace(/\n\s*Keywords:.*$/i, "").trim();
}

/** Cosine similarity threshold — results below this are considered noise. */
const VECTOR_SIM_THRESHOLD = 0.5;
/** Maximum vector search candidates before filtering. */
const VECTOR_LIMIT = 10;
/** Maximum FTS candidates before filtering. */
const FTS_LIMIT = 10;

export async function searchMemory(query: string) {
  const db = await getDb();
  const tableNames = await db.tableNames();
  if (!tableNames.includes(TABLE_NAME)) return [];

  const table = await db.openTable(TABLE_NAME);

  // Generate query embedding for vector search
  let queryVector: number[] = [];
  try {
    queryVector = await embedText(query);
  } catch (e) {
    console.error("[Vector Store] Embedding generation failed", e);
    return [];
  }

  // --- 1. Vector search (semantic similarity) ---
  let vectorResults: Record<string, unknown>[] = [];
  try {
    const raw = await table
      .vectorSearch(queryVector)
      .distanceType("cosine")
      .limit(VECTOR_LIMIT)
      .toArray();

    // _distance is cosine distance (0 = identical). Convert to similarity and filter.
    vectorResults = raw.filter(
      (r) => 1 - ((r._distance as number) || 0) >= VECTOR_SIM_THRESHOLD,
    );
    console.log(
      `[Vector Store] Vector search: ${raw.length} raw → ${vectorResults.length} after cosine ≥ ${VECTOR_SIM_THRESHOLD}`,
    );
  } catch (e) {
    console.error("[Vector Store] Vector search failed", e);
  }

  // --- 2. Full-text search (keyword matching) ---
  let ftsResults: Record<string, unknown>[] = [];
  try {
    const raw = await table.search(query, "fts").limit(FTS_LIMIT).toArray();

    // Keep only results with a positive BM25 score (at least one keyword matched).
    ftsResults = raw.filter((r) => ((r._score as number) ?? 0) > 0);
    console.log(
      `[Vector Store] FTS: ${raw.length} raw → ${ftsResults.length} after BM25 > 0`,
    );
  } catch (ftsError) {
    // FTS index may not exist yet — this is non-fatal.
    console.warn(
      "[Vector Store] FTS unavailable (index may be missing), skipping.",
      ftsError,
    );
  }

  // --- 3. Union + deduplicate by id ---
  const seen = new Set<string>();
  const merged: Record<string, unknown>[] = [];

  for (const r of vectorResults) {
    const id = r.id as string;
    if (!seen.has(id)) {
      seen.add(id);
      merged.push(r);
    }
  }
  for (const r of ftsResults) {
    const id = r.id as string;
    if (!seen.has(id)) {
      seen.add(id);
      merged.push(r);
    }
  }

  console.log(
    `[Vector Store] Merged: ${merged.length} unique candidates (vector: ${vectorResults.length}, fts: ${ftsResults.length})`,
  );

  // Strip the raw embedding vector and clean keywords from content.
  return merged.map(({ vector, ...rest }) => ({
    ...rest,
    content: stripKeywordsLine(rest.content as string),
  }));
}
