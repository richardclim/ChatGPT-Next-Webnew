/**
 * @jest-environment jsdom
 */
import { TextDecoder, TextEncoder } from "util";
if (typeof global.TextDecoder === "undefined") {
  (global as any).TextDecoder = TextDecoder;
  (global as any).TextEncoder = TextEncoder;
}
import { jest, describe, it, expect, beforeEach, beforeAll } from "@jest/globals";
import * as lancedb from "@lancedb/lancedb";

// Force Env var
process.env.GOOGLE_API_KEY = "test-key";

const mockEmbedContent = jest.fn<any>();
const mockGetGenerativeModel = jest.fn<any>(() => ({
  embedContent: mockEmbedContent,
}));

const mockTable = {
  add: jest.fn<any>(),
  search: jest.fn<any>(),
  vectorSearch: jest.fn<any>(),
  fullTextSearch: jest.fn<any>(),
  distanceType: jest.fn<any>(),
  rerank: jest.fn<any>(),
  limit: jest.fn<any>(),
  toArray: jest.fn<any>(),
  createIndex: jest.fn<any>(),
  listIndices: jest.fn<any>(),
  delete: jest.fn<any>(),
};

(mockTable.search as any).mockReturnValue(mockTable);
(mockTable.vectorSearch as any).mockReturnValue(mockTable);
(mockTable.fullTextSearch as any).mockReturnValue(mockTable);
(mockTable.distanceType as any).mockReturnValue(mockTable);
(mockTable.rerank as any).mockReturnValue(mockTable);
(mockTable.limit as any).mockReturnValue(mockTable);

const mockConnection = {
  tableNames: jest.fn<any>(),
  createTable: jest.fn<any>(),
  openTable: jest.fn<any>(),
};

const mockConnect = jest.fn<any>();

// Mocking external deps
jest.mock("@google/generative-ai", () => ({
  GoogleGenerativeAI: jest.fn<any>().mockImplementation(() => ({
    getGenerativeModel: mockGetGenerativeModel,
  })),
}));

jest.mock("@lancedb/lancedb", () => ({
  connect: (uri: string) => mockConnect(uri),
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
let upsertMemory: any, searchMemory: any;

describe("Vector Store", () => {
  beforeAll(async () => {
    // Import after mocks are set up
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
    mockConnection.tableNames.mockResolvedValue(["episodic_memory"]);
    mockConnection.createTable.mockResolvedValue(mockTable);
    mockConnection.openTable.mockResolvedValue(mockTable);
    (mockTable.toArray as any).mockResolvedValue([]);
    (mockTable.listIndices as any).mockResolvedValue([]);
  });

  describe("upsertMemory", () => {
    it("should INSERT when low similarity (new topic)", async () => {
      // 1. vectorSearch returns existing but low similarity
      (mockTable.toArray as any).mockResolvedValue([
        { content: "old content", _distance: 0.5, id: "old_id" }, 
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

    it("should ask LLM and MERGE when ambiguity exists", async () => {
      (mockTable.toArray as any).mockResolvedValue([
        { content: "I have a cat", _distance: 0.15, id: "old_id" }, 
      ]);

      const mockAskLLM = jest.fn<any>().mockResolvedValue({
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

      expect(mockTable.delete).toHaveBeenCalledWith(`id = 'old_id'`);
      expect(mockTable.add).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ content: "I have a cat named Max" }),
        ]),
      );
    });
  });

  describe("searchMemory", () => {
    it("should use hybrid/FTS search and apply relative threshold", async () => {
      // Setup FTS results with varying scores
      (mockTable.toArray as any)
        .mockResolvedValueOnce([{ content: "vector result", _distance: 0.1 }]) // Vector path
        .mockResolvedValueOnce([ // FTS path
          { content: "top match", _score: 10.0, id: "a" },
          { content: "good match", _score: 7.0, id: "b" }, 
          { content: "low match", _score: 3.0, id: "c" } // Should be filtered (3.0 < 10.0 * 0.6)
        ]);

      const results = await searchMemory({ 
        semanticQuery: "query", 
        keywordQuery: "keywords" 
      });

      // Should have: vector result, top match, good match. (low match filtered out)
      expect(results.length).toBe(3);
      const contents = results.map((r: any) => r.content);
      expect(contents).toContain("vector result");
      expect(contents).toContain("top match");
      expect(contents).toContain("good match");
      expect(contents).not.toContain("low match");
    });

    it("should fallback to vector search if FTS fails", async () => {
      // Mock FTS to throw
      mockTable.search.mockImplementationOnce(() => {
        throw new Error("FTS failed");
      });

      (mockTable.toArray as any).mockResolvedValue([{ content: "vector fallback" }]);

      const results = await searchMemory({ 
        semanticQuery: "query", 
        keywordQuery: "keywords" 
      });

      expect(results).toEqual([{ content: "vector fallback" }]);
    });
  });
});
