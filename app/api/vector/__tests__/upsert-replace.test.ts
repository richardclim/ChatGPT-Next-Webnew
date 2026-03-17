// All mock references must be declared with `var` so they are hoisted
// alongside jest.mock calls (which are also hoisted by Jest).
/* eslint-disable no-var */
var mockDelete = jest.fn().mockResolvedValue(undefined);
var mockAdd = jest.fn().mockResolvedValue(undefined);
var mockVectorSearch = jest.fn();
var mockListIndices = jest.fn().mockResolvedValue([]);
var mockCreateIndex = jest.fn().mockResolvedValue(undefined);
var mockTable = {
  delete: mockDelete,
  add: mockAdd,
  vectorSearch: mockVectorSearch,
  listIndices: mockListIndices,
  createIndex: mockCreateIndex,
};
var mockTableNames = jest.fn().mockResolvedValue(["episodic_memory"]);
var nanoidCounter = 0;
/* eslint-enable no-var */

jest.mock("@lancedb/lancedb", () => ({
  connect: jest.fn(() =>
    Promise.resolve({
      tableNames: (...args: unknown[]) => mockTableNames(...args),
      openTable: jest.fn(() => Promise.resolve(mockTable)),
      createTable: jest.fn(() => Promise.resolve(mockTable)),
    }),
  ),
  Index: { fts: jest.fn() },
  rerankers: {
    RRFReranker: { create: jest.fn() },
  },
}));

jest.mock("@google/generative-ai", () => ({
  GoogleGenerativeAI: jest.fn().mockImplementation(() => ({
    getGenerativeModel: jest.fn().mockReturnValue({
      embedContent: jest.fn().mockResolvedValue({
        embedding: { values: [0.1, 0.2, 0.3] },
      }),
    }),
  })),
}));

jest.mock("@/app/config/server", () => ({
  getServerSideConfig: jest.fn().mockReturnValue({
    googleApiKey: "test-key",
  }),
}));

jest.mock("nanoid", () => ({
  nanoid: jest.fn(() => `mock-id-${++nanoidCounter}`),
}));

jest.mock("fs", () => ({
  existsSync: jest.fn().mockReturnValue(true),
  mkdirSync: jest.fn(),
}));

jest.mock("path", () => ({
  join: jest.fn((...args: string[]) => args.join("/")),
  dirname: jest.fn((p: string) => p.split("/").slice(0, -1).join("/")),
}));

import * as fc from "fast-check";
import { upsertMemory, type MemoryChunk } from "../store";

beforeEach(() => {
  nanoidCounter = 0;
  mockDelete.mockClear();
  mockAdd.mockClear();
  mockVectorSearch.mockClear();
  mockListIndices.mockClear();
  mockCreateIndex.mockClear();
  mockTableNames.mockResolvedValue(["episodic_memory"]);
  mockDelete.mockResolvedValue(undefined);
  mockAdd.mockResolvedValue(undefined);
  mockListIndices.mockResolvedValue([]);
  mockCreateIndex.mockResolvedValue(undefined);
});

/**
 * Feature: episodic-memory-continuity, Property 4: Direct replace skips similarity routing and performs atomic delete-then-insert
 * Validates: Requirements 6.1, 6.2, 6.3, 6.4, 6.6
 */
describe("Property 4: Direct replace skips similarity routing and performs atomic delete-then-insert", () => {
  const arbSessionId = fc.string({ minLength: 1, maxLength: 20 });
  const arbContent = fc.string({ minLength: 1, maxLength: 200 });
  const arbReplaceEntryId = fc.string({ minLength: 1, maxLength: 30 });
  const arbKeywords = fc.array(fc.string({ minLength: 1, maxLength: 20 }), {
    minLength: 0,
    maxLength: 5,
  });
  const arbCreatedAt = fc.nat({ max: 1_700_000_000_000 });

  const arbChunkWithReplace = fc
    .record({
      sessionId: arbSessionId,
      content: arbContent,
      replaceEntryId: arbReplaceEntryId,
      keywords: arbKeywords,
      createdAt: arbCreatedAt,
    })
    .map(
      (r): MemoryChunk => ({
        id: r.sessionId,
        content: r.content,
        sessionId: r.sessionId,
        replaceEntryId: r.replaceEntryId,
        keywords: r.keywords,
        createdAt: r.createdAt,
      }),
    );

  it("should call table.delete with the replaceEntryId", async () => {
    await fc.assert(
      fc.asyncProperty(arbChunkWithReplace, async (chunk) => {
        mockDelete.mockClear();
        mockAdd.mockClear();
        mockVectorSearch.mockClear();
        nanoidCounter = 0;

        await upsertMemory([chunk]);

        // Req 6.2: delete is called with the replaceEntryId
        expect(mockDelete).toHaveBeenCalledTimes(1);
        expect(mockDelete).toHaveBeenCalledWith(
          `id = '${chunk.replaceEntryId}'`,
        );
      }),
      { numRuns: 100 },
    );
  });

  it("should insert a new entry with a fresh ID and new embedding", async () => {
    await fc.assert(
      fc.asyncProperty(arbChunkWithReplace, async (chunk) => {
        mockDelete.mockClear();
        mockAdd.mockClear();
        mockVectorSearch.mockClear();
        nanoidCounter = 0;

        await upsertMemory([chunk]);

        // Req 6.2, 6.6: add is called with a fresh nanoid-generated ID
        expect(mockAdd).toHaveBeenCalledTimes(1);
        const addedData = mockAdd.mock.calls[0][0];
        expect(addedData).toHaveLength(1);
        const insertedEntry = addedData[0];

        // Fresh ID, not the old replaceEntryId
        expect(insertedEntry.id).not.toBe(chunk.replaceEntryId);
        expect(insertedEntry.id).toBe("mock-id-1");

        // Req 6.6: new embedding vector is generated
        expect(insertedEntry.vector).toEqual([0.1, 0.2, 0.3]);

        // Content matches the chunk
        expect(insertedEntry.content).toBe(chunk.content);
        expect(insertedEntry.sessionId).toBe(chunk.sessionId);
      }),
      { numRuns: 100 },
    );
  });

  it("should NOT call vectorSearch (similarity routing skipped)", async () => {
    await fc.assert(
      fc.asyncProperty(arbChunkWithReplace, async (chunk) => {
        mockDelete.mockClear();
        mockAdd.mockClear();
        mockVectorSearch.mockClear();
        nanoidCounter = 0;

        await upsertMemory([chunk]);

        // Req 6.4: similarity search is never invoked for direct replace
        expect(mockVectorSearch).not.toHaveBeenCalled();
      }),
      { numRuns: 100 },
    );
  });

  it("should NOT call the askLLM callback", async () => {
    await fc.assert(
      fc.asyncProperty(arbChunkWithReplace, async (chunk) => {
        mockDelete.mockClear();
        mockAdd.mockClear();
        mockVectorSearch.mockClear();
        nanoidCounter = 0;

        const mockAskLLM = jest.fn();
        await upsertMemory([chunk], mockAskLLM);

        // Req 6.4: LLM-based routing is skipped entirely
        expect(mockAskLLM).not.toHaveBeenCalled();
      }),
      { numRuns: 100 },
    );
  });

  it("should return the new fresh entry ID", async () => {
    await fc.assert(
      fc.asyncProperty(arbChunkWithReplace, async (chunk) => {
        mockDelete.mockClear();
        mockAdd.mockClear();
        mockVectorSearch.mockClear();
        nanoidCounter = 0;

        const result = await upsertMemory([chunk]);

        // Returned ID is the fresh nanoid, not the replaceEntryId
        expect(result).toBe("mock-id-1");
        expect(result).not.toBe(chunk.replaceEntryId);
      }),
      { numRuns: 100 },
    );
  });

  it("should still insert when delete fails (entry does not exist)", async () => {
    await fc.assert(
      fc.asyncProperty(arbChunkWithReplace, async (chunk) => {
        mockDelete.mockClear();
        mockAdd.mockClear();
        mockVectorSearch.mockClear();
        nanoidCounter = 0;

        // Simulate delete failure (entry doesn't exist)
        mockDelete.mockRejectedValueOnce(new Error("Entry not found"));

        const result = await upsertMemory([chunk]);

        // Req 6.3: chunk is still inserted despite delete failure
        expect(mockAdd).toHaveBeenCalledTimes(1);
        expect(result).toBe("mock-id-1");

        const addedData = mockAdd.mock.calls[0][0];
        expect(addedData[0].content).toBe(chunk.content);
        expect(addedData[0].vector).toEqual([0.1, 0.2, 0.3]);
      }),
      { numRuns: 100 },
    );
  });
});

/**
 * Feature: episodic-memory-continuity, Property 5: Upsert response contains the new entry ID
 * Validates: Requirements 6.5
 */
describe("Property 5: Upsert response contains the new entry ID", () => {
  const arbSessionId = fc.string({ minLength: 1, maxLength: 20 });
  const arbContent = fc.string({ minLength: 1, maxLength: 200 });
  const arbReplaceEntryId = fc.string({ minLength: 1, maxLength: 30 });
  const arbKeywords = fc.array(fc.string({ minLength: 1, maxLength: 20 }), {
    minLength: 0,
    maxLength: 5,
  });
  const arbCreatedAt = fc.nat({ max: 1_700_000_000_000 });

  const arbChunkWithReplace = fc
    .record({
      sessionId: arbSessionId,
      content: arbContent,
      replaceEntryId: arbReplaceEntryId,
      keywords: arbKeywords,
      createdAt: arbCreatedAt,
    })
    .map(
      (r): MemoryChunk => ({
        id: r.sessionId,
        content: r.content,
        sessionId: r.sessionId,
        replaceEntryId: r.replaceEntryId,
        keywords: r.keywords,
        createdAt: r.createdAt,
      }),
    );

  const arbChunkWithoutReplace = fc
    .record({
      sessionId: arbSessionId,
      content: arbContent,
      keywords: arbKeywords,
      createdAt: arbCreatedAt,
    })
    .map(
      (r): MemoryChunk => ({
        id: r.sessionId,
        content: r.content,
        sessionId: r.sessionId,
        keywords: r.keywords,
        createdAt: r.createdAt,
      }),
    );

  it("should return the new entry ID for a chunk with replaceEntryId", async () => {
    await fc.assert(
      fc.asyncProperty(arbChunkWithReplace, async (chunk) => {
        mockDelete.mockClear();
        mockAdd.mockClear();
        mockVectorSearch.mockClear();
        nanoidCounter = 0;

        const result = await upsertMemory([chunk]);

        // Req 6.5: response contains the entryId of the newly created entry
        expect(result).toBeDefined();
        expect(typeof result).toBe("string");
        expect(result).toBe("mock-id-1");
      }),
      { numRuns: 100 },
    );
  });

  it("should return the new entry ID for a chunk without replaceEntryId (normal insert)", async () => {
    await fc.assert(
      fc.asyncProperty(arbChunkWithoutReplace, async (chunk) => {
        mockDelete.mockClear();
        mockAdd.mockClear();
        mockVectorSearch.mockClear();
        nanoidCounter = 0;

        // No similar entries found → INSERT path
        mockVectorSearch.mockReturnValue({
          distanceType: jest.fn().mockReturnValue({
            limit: jest.fn().mockReturnValue({
              toArray: jest.fn().mockResolvedValue([]),
            }),
          }),
        });

        const result = await upsertMemory([chunk]);

        // Req 6.5: response contains the entryId of the newly created entry
        expect(result).toBeDefined();
        expect(typeof result).toBe("string");
        // Normal insert uses chunk.id when available
        expect(result).toBe(chunk.id);
      }),
      { numRuns: 100 },
    );
  });
});
