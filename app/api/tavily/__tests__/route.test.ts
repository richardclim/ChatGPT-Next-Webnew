jest.mock("next/server", () => ({
  NextRequest: global.Request,
  NextResponse: {
    json: (data: any, init: any) => global.Response.json(data, init),
  },
}));

const { NextRequest, NextResponse } = require("next/server");
const { POST } = require("../route");

// Mock global fetch for Tavily API calls
global.fetch = jest.fn() as any;

describe("Tavily API Route - URL Deduplication", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.TAVILY_API_KEY = "test-key";
  });

  const createMockRequest = (body: any) => {
    return new NextRequest("http://localhost/api/tavily", {
      method: "POST",
      body: JSON.stringify(body),
    });
  };

  it("should merge search results with different tracking parameters into a single entry", async () => {
    // Mock Tavily Search API response
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          results: [
            {
              url: "https://www.example.com/product?srsltid=ABC&utm_source=google",
              title: "Cool Product",
              content: "Snippet A",
              score: 0.8,
            },
          ],
        }),
    });

    // Mock a second call for a second query (to simulate multiple queries returning same site)
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          results: [
            {
              url: "https://www.example.com/product?srsltid=ABC&utm_source=google",
              title: "Cool Product",
              content: "Snippet A",
              score: 0.8,
            },
          ],
        }),
    }).mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          results: [
            {
              url: "https://www.example.com/product?srsltid=XYZ&utm_medium=email",
              title: "Cool Product",
              content: "Snippet B",
              score: 0.95,
            },
          ],
        }),
    });

    const req = createMockRequest({
      queries: ["query 1", "query 2"],
      maxResults: 5,
    });

    const response = await POST(req);
    const data = await response.json();

    // Verify deduplication
    expect(data.results).toHaveLength(1);
    
    const result = data.results[0];
    // Should preserve the first original URL seen
    expect(result.url).toBe("https://www.example.com/product?srsltid=ABC&utm_source=google");
    // Should merge unique content
    expect(result.content).toContain("Snippet A");
    expect(result.content).toContain("Snippet B");
    // Should take the highest score
    expect(result.score).toBe(0.95);
    // Should track both queries
    expect(result.matched_queries).toContain("query 1");
    expect(result.matched_queries).toContain("query 2");
  });

  it("should strip hash fragments during deduplication", async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          results: [
            {
              url: "https://example.com/page#section1",
              title: "Page",
              content: "Part 1",
            },
          ],
        }),
    }).mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          results: [
            {
              url: "https://example.com/page#section2",
              title: "Page",
              content: "Part 2",
            },
          ],
        }),
    });

    const req = createMockRequest({
      queries: ["q1", "q2"],
    });

    const response = await POST(req);
    const data = await response.json();

    expect(data.results).toHaveLength(1);
    expect(data.results[0].content).toContain("Part 1");
    expect(data.results[0].content).toContain("Part 2");
  });

  it("should NOT merge different products/pages", async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          results: [
            {
              url: "https://example.com/product-a",
              title: "A",
              content: "Content A",
            },
          ],
        }),
    }).mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          results: [
            {
              url: "https://example.com/product-b",
              title: "B",
              content: "Content B",
            },
          ],
        }),
    });

    const req = createMockRequest({
      queries: ["q1", "q2"],
    });

    const response = await POST(req);
    const data = await response.json();

    expect(data.results).toHaveLength(2);
  });
});
