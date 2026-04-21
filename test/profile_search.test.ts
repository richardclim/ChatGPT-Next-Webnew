/**
 * @jest-environment jsdom
 */
import { TextDecoder, TextEncoder } from "util";
if (typeof global.TextDecoder === "undefined") {
  (global as any).TextDecoder = TextDecoder;
  (global as any).TextEncoder = TextEncoder;
}
import { jest, describe, it, expect, beforeEach, beforeAll } from "@jest/globals";

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

// MUST MOCK NANOID TO AVOID IMPORT ERRORS
jest.mock("nanoid", () => ({
  nanoid: () => "mock_nanoid",
}));

let searchProfileTable: any;

describe("Profile Hybrid Search", () => {
  beforeAll(async () => {
    const storeModule = await import("../app/api/vector/store");
    searchProfileTable = storeModule.searchProfileTable;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockEmbedContent.mockImplementation(() => Promise.resolve({
      embedding: { values: [0.1, 0.2, 0.3] },
    }));
    mockConnect.mockResolvedValue(mockConnection);
    // MUST mock tableNames so the code can verify the table exists
    mockConnection.tableNames.mockResolvedValue(["profile_memory", "episodic_memory"]);
    mockConnection.openTable.mockResolvedValue(mockTable);
  });

  it("should merge and deduplicate Vector and FTS results", async () => {
    // Return identical IDs in both search types to test deduplication
    (mockTable.toArray as any)
      .mockResolvedValueOnce([ // Vector Results
        { id: "1", content: "Profile Fact A", _distance: 0.05 }
      ])
      .mockResolvedValueOnce([ // FTS Results
        { id: "1", content: "Profile Fact A", _score: 15.0 }, // Duplicate ID
        { id: "2", content: "Profile Fact B", _score: 12.0 }  // New unique ID
      ]);

    const results = await searchProfileTable({
      semanticQuery: "phrase",
      keywordQuery: "keywords"
    });

    // Should only have 2 unique results
    expect(results.length).toBe(2);
    const ids = results.map((r: any) => r.id);
    expect(ids).toContain("1");
    expect(ids).toContain("2");
    
    // The first one (from Vector) should win
    expect(results[0]).toHaveProperty("_distance");
    expect(results[0]).not.toHaveProperty("_score");
  });

  it("should handle empty results gracefully", async () => {
    (mockTable.toArray as any).mockResolvedValue([]);

    const results = await searchProfileTable({
      semanticQuery: "phrase",
      keywordQuery: "keywords"
    });

    expect(results).toEqual([]);
  });
});
