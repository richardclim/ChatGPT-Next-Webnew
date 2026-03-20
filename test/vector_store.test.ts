/**
 * @jest-environment jsdom
 */
import { TextDecoder, TextEncoder } from "util";
if (typeof global.TextDecoder === "undefined") {
  (global as any).TextDecoder = TextDecoder;
  (global as any).TextEncoder = TextEncoder;
}
import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import * as lancedb from "@lancedb/lancedb";

// Force Env var
process.env.GOOGLE_API_KEY = "test-key";

const mockEmbedContent = jest.fn();
const mockGetGenerativeModel = jest.fn(() => ({
  embedContent: mockEmbedContent,
}));
const mockGoogleGenerativeAI = jest.fn(() => ({
  getGenerativeModel: mockGetGenerativeModel,
}));

const mockTable = {
  add: jest.fn(),
  search: jest.fn(),
  vectorSearch: jest.fn(),
  fullTextSearch: jest.fn(),
  distanceType: jest.fn(),
  rerank: jest.fn(),
  limit: jest.fn(),
  toArray: jest.fn(),
  createIndex: jest.fn(),
  listIndices: jest.fn(),
  delete: jest.fn(), // Added delete support
};
(mockTable.search as any).mockReturnValue(mockTable);
(mockTable.vectorSearch as any).mockReturnValue(mockTable);
(mockTable.fullTextSearch as any).mockReturnValue(mockTable);
(mockTable.distanceType as any).mockReturnValue(mockTable);
(mockTable.rerank as any).mockReturnValue(mockTable);
(mockTable.limit as any).mockReturnValue(mockTable);

const mockConnection = {
  tableNames: jest.fn(),
  createTable: jest.fn(),
  openTable: jest.fn(),
};

const mockConnect = jest.fn();

// Use jest.mock for easier CommonJS mocking unless forced
jest.mock("@google/generative-ai", () => ({
  GoogleGenerativeAI: jest.fn<any>().mockImplementation(() => ({
    getGenerativeModel: mockGetGenerativeModel,
  })),
}));

jest.mock("@lancedb/lancedb", () => ({
  connect: mockConnect,
  Index: {
    fts: jest.fn(),
  },
  rerankers: {
    RRFReranker: {
      create: jest.fn<any>(),
    },
  },
}));

jest.mock("nanoid", () => ({
  nanoid: () => "mock_nanoid",
}));

// Dynamic import of the system under test
// Note: We need to wait for mocks to be registered
let upsertMemory: any, searchMemory: any;

describe("Vector Store", () => {
  beforeAll(async () => {
    const storeModule = await import("../app/api/vector/store");
    upsertMemory = storeModule.upsertMemory;
    searchMemory = storeModule.searchMemory;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.GOOGLE_API_KEY = "test-key";

    // Default behaviors
    mockEmbedContent.mockImplementation(() => Promise.resolve({
      embedding: { values: [0.1, 0.2, 0.3] },
    }));

    mockConnect.mockResolvedValue(mockConnection);
    mockConnection.createTable.mockResolvedValue(mockTable);
    mockConnection.openTable.mockResolvedValue(mockTable);
    (mockTable.toArray as any).mockResolvedValue([]);
    (mockTable.listIndices as any).mockResolvedValue([]);
  });

  describe("upsertMemory", () => {
    it("should INSERT when low similarity (new topic)", async () => {
      mockConnection.tableNames.mockResolvedValue(["episodic_memory"]);
      // 1. vectorSearch returns existing but low similarity
      (mockTable.toArray as any).mockResolvedValue([
        { content: "old content", _distance: 0.5, id: "old_id" }, // Similarity 0.5 < 0.8
      ]);

      const chunks = [
        { id: "1", content: "new content", sessionIds: ["s1"], createdAt: 123 },
      ];
      await upsertMemory(chunks);

      expect(mockTable.add).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ content: "new content" }),
        ]),
      );
    });

    it("should IGNORE when high similarity (exact duplicate)", async () => {
      mockConnection.tableNames.mockResolvedValue(["episodic_memory"]);
      // 1. vectorSearch returns almost identical
      (mockTable.toArray as any).mockResolvedValue([
        { content: "old content", _distance: 0.001, id: "old_id" }, // Similarity 0.999 > 0.99
      ]);

      const chunks = [
        { id: "1", content: "new content", sessionIds: ["s1"], createdAt: 123 },
      ];
      await upsertMemory(chunks);

      // Should NOT add
      expect(mockTable.add).not.toHaveBeenCalled();
    });

    it("should ask LLM and MERGE when ambiguity exists", async () => {
      mockConnection.tableNames.mockResolvedValue(["episodic_memory"]);
      // 1. vectorSearch returns ambiguity
      (mockTable.toArray as any).mockResolvedValue([
        { content: "I have a cat", _distance: 0.15, id: "old_id" }, // Similarity 0.85 (Ambiguous)
      ]);

      const mockAskLLM = jest.fn().mockResolvedValue({
        action: "MERGE",
        mergedContent: "I have a cat named Max",
      });

      const chunks = [
        {
          id: "1",
          content: "His name is Max",
          sessionIds: ["s1"],
          createdAt: 123,
        },
      ];
      await upsertMemory(chunks, mockAskLLM as any);

      // Should delete old
      expect(mockTable.delete).toHaveBeenCalledWith(`id = 'old_id'`);
      // Should insert merged
      expect(mockTable.add).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ content: "I have a cat named Max" }),
        ]),
      );
    });

    it("should ask LLM and INSERT when it decides distinct", async () => {
      mockConnection.tableNames.mockResolvedValue(["episodic_memory"]);
      // 1. vectorSearch returns ambiguity
      (mockTable.toArray as any).mockResolvedValue([
        { content: "Ate pizza on Mon", _distance: 0.15, id: "old_id" }, // Similarity 0.85
      ]);

      const mockAskLLM = jest.fn().mockResolvedValue({
        action: "INSERT",
      });

      const chunks = [
        {
          id: "1",
          content: "Ate pizza on Tue",
          sessionIds: ["s1"],
          createdAt: 123,
        },
      ];
      await upsertMemory(chunks, mockAskLLM as any);

      // Should NOT delete old
      expect(mockTable.delete).not.toHaveBeenCalled();
      // Should insert new
      expect(mockTable.add).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ content: "Ate pizza on Tue" }),
        ]),
      );
    });
  });

  describe("searchMemory", () => {
    it("should use hybrid/FTS search first", async () => {
      mockConnection.tableNames.mockResolvedValue(["episodic_memory"]);
      (mockTable.toArray as any).mockResolvedValue([{ content: "result" }]);
      // Mock reranker create
      (lancedb.rerankers.RRFReranker.create as any) = jest
        .fn()
        .mockReturnValue({});

      await searchMemory("query");

      expect(mockTable.vectorSearch).toHaveBeenCalled();
      expect(mockTable.fullTextSearch).toHaveBeenCalledWith("query");
    });

    it("should fallback to vector search if hybrid fails", async () => {
      mockConnection.tableNames.mockResolvedValue(["episodic_memory"]);
      (lancedb.rerankers.RRFReranker.create as any) = jest
        .fn()
        .mockReturnValue({});

      // First call setup (Hybrid) -> fails at some point, maybe toArray?
      // actually `searchMemory` creates reranker then chains.
      // let's mock fullTextSearch to throw
      (mockTable.fullTextSearch as any).mockImplementationOnce(() => {
        throw new Error("FTS failed");
      });

      // Second call (Fallback Vector Only)
      // will call vectorSearch...limit...toArray
      (mockTable.toArray as any).mockResolvedValueOnce([
        { content: "vector result" },
      ]);

      const results = await searchMemory("query");

      expect(results).toEqual([{ content: "vector result" }]);
      // Should have tried vectorSearch twice (once in hybrid chain, once in fallback)
      expect(mockTable.vectorSearch).toHaveBeenCalledTimes(2);
    });
  });
});
