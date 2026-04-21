// All mock references must be declared with `var` so they are hoisted
// alongside jest.mock calls (which are also hoisted by Jest).
/* eslint-disable no-var */
var mockDelete = jest.fn<any, any>().mockResolvedValue(undefined);
var mockAdd = jest.fn<any, any>().mockResolvedValue(undefined);
var mockVectorSearch = jest.fn<any, any>();
var mockListIndices = jest.fn<any, any>().mockResolvedValue([]);
var mockCreateIndex = jest.fn<any, any>().mockResolvedValue(undefined);

var mockTable: any = {
  delete: mockDelete,
  add: mockAdd,
  vectorSearch: mockVectorSearch,
  listIndices: mockListIndices,
  createIndex: mockCreateIndex,
  query: jest.fn<any, any>(() => mockTable),
  where: jest.fn<any, any>(() => mockTable),
  limit: jest.fn<any, any>(() => mockTable),
  toArray: jest.fn<any, any>(() => Promise.resolve([])),
};

var mockTableNames = jest.fn<any, any>().mockResolvedValue(["episodic_memory"]);
var nanoidCounter = 0;
/* eslint-enable no-var */

jest.mock("@lancedb/lancedb", () => ({
  connect: jest.fn<any, any>(() =>
    Promise.resolve({
      tableNames: (...args: unknown[]) => mockTableNames(...args),
      openTable: jest.fn<any, any>(() => Promise.resolve(mockTable)),
      createTable: jest.fn<any, any>(() => Promise.resolve(mockTable)),
    }),
  ),
  Index: { fts: jest.fn() },
  rerankers: {
    RRFReranker: { create: jest.fn() },
  },
}));

jest.mock("@google/generative-ai", () => ({
  GoogleGenerativeAI: jest.fn<any, any>().mockImplementation(() => ({
    getGenerativeModel: jest.fn<any, any>().mockReturnValue({
      embedContent: jest.fn<any, any>().mockResolvedValue({
        embedding: { values: [0.1, 0.2, 0.3] },
      }),
    }),
  })),
}));

jest.mock("@/app/config/server", () => ({
  getServerSideConfig: jest.fn<any, any>().mockReturnValue({
    googleApiKey: "test-key",
  }),
}));

jest.mock("nanoid", () => ({
  nanoid: jest.fn<any, any>(() => `mock-id-${++nanoidCounter}`),
}));

jest.mock("fs", () => ({
  existsSync: jest.fn<any, any>().mockReturnValue(true),
  mkdirSync: jest.fn<any, any>(),
}));

jest.mock("path", () => ({
  join: jest.fn<any, any>((...args: string[]) => args.join("/")),
  dirname: jest.fn<any, any>((p: string) => p.split("/").slice(0, -1).join("/")),
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
  // Reset query chain behavior
  mockTable.toArray.mockResolvedValue([]);
});

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
        sessionIds: [r.sessionId],
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

        expect(mockDelete).toHaveBeenCalledTimes(1);
        expect(mockDelete).toHaveBeenCalledWith(
          `id = '${chunk.replaceEntryId}'`,
        );
      }),
      { numRuns: 50 },
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

        expect(mockAdd).toHaveBeenCalledTimes(1);
        const addedData = mockAdd.mock.calls[0][0];
        expect(addedData).toHaveLength(1);
        const insertedEntry = addedData[0];

        expect(insertedEntry.id).not.toBe(chunk.replaceEntryId);
        expect(insertedEntry.id).toBe("mock-id-1");
        expect(insertedEntry.vector).toEqual([0.1, 0.2, 0.3]);
        expect(insertedEntry.content).toBe(chunk.content);
        expect(insertedEntry.sessionIds).toEqual(chunk.sessionIds);
      }),
      { numRuns: 50 },
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

        expect(mockVectorSearch).not.toHaveBeenCalled();
      }),
      { numRuns: 50 },
    );
  });

  it("should NOT call the askLLM callback", async () => {
    await fc.assert(
      fc.asyncProperty(arbChunkWithReplace, async (chunk) => {
        mockDelete.mockClear();
        mockAdd.mockClear();
        mockVectorSearch.mockClear();
        nanoidCounter = 0;

        const mockAskLLM = jest.fn<any, any>();
        await upsertMemory([chunk], mockAskLLM);

        expect(mockAskLLM).not.toHaveBeenCalled();
      }),
      { numRuns: 50 },
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

        expect(result).toBe("mock-id-1");
      }),
      { numRuns: 50 },
    );
  });

  it("should still insert when delete fails (entry does not exist)", async () => {
    await fc.assert(
      fc.asyncProperty(arbChunkWithReplace, async (chunk) => {
        mockDelete.mockClear();
        mockAdd.mockClear();
        mockVectorSearch.mockClear();
        nanoidCounter = 0;

        mockDelete.mockRejectedValueOnce(new Error("Entry not found"));

        const result = await upsertMemory([chunk]);

        expect(mockAdd).toHaveBeenCalledTimes(1);
        expect(result).toBe("mock-id-1");

        const addedData = mockAdd.mock.calls[0][0];
        expect(addedData[0].content).toBe(chunk.content);
      }),
      { numRuns: 50 },
    );
  });
});

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
        sessionIds: [r.sessionId],
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
        sessionIds: [r.sessionId],
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

        expect(result).toBeDefined();
        expect(result).toBe("mock-id-1");
      }),
      { numRuns: 50 },
    );
  });

  it("should return the new entry ID for a chunk without replaceEntryId (normal insert)", async () => {
    await fc.assert(
      fc.asyncProperty(arbChunkWithoutReplace, async (chunk) => {
        mockDelete.mockClear();
        mockAdd.mockClear();
        mockVectorSearch.mockClear();
        nanoidCounter = 0;

        // No similar entries found -> INSERT path
        mockTable.toArray.mockResolvedValue([]);
        mockVectorSearch.mockReturnValue({
          distanceType: jest.fn<any, any>().mockReturnValue({
            limit: jest.fn<any, any>().mockReturnValue({
              toArray: jest.fn<any, any>().mockResolvedValue([]),
            }),
          }),
        });

        const result = await upsertMemory([chunk]);

        expect(result).toBeDefined();
        expect(result).toBe(chunk.id);
      }),
      { numRuns: 50 },
    );
  });
});
