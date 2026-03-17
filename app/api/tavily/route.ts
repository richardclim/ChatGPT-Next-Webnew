import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { queries, type, maxResults, maxChunksPerSource, apiKey } = body;

    const tavilyApiKey = apiKey || process.env.TAVILY_API_KEY;

    if (!tavilyApiKey) {
      return NextResponse.json(
        { error: "Tavily API key is missing." },
        { status: 401 },
      );
    }

    if (!queries || !Array.isArray(queries) || queries.length === 0) {
      return NextResponse.json(
        { error: "Queries array is required." },
        { status: 400 },
      );
    }

    // Determine search depth and content flags based on user preferences
    let searchDepth = "basic";
    let includeRawContent = false;

    if (type === "advanced") {
      searchDepth = "advanced";
    } else if (type === "extract") {
      searchDepth = "advanced";
      includeRawContent = true;
    }

    // Split queries into URLs and text searches
    const urlQueries = queries.filter(
      (q: string) => q.startsWith("http://") || q.startsWith("https://"),
    );
    const textQueries = queries.filter(
      (q: string) => !(q.startsWith("http://") || q.startsWith("https://")),
    );

    let aggregatedResults: any[] = [];
    const promises: Promise<void>[] = [];

    // 1. Process URL queries with the Extract API
    if (urlQueries.length > 0) {
      promises.push(
        (async () => {
          const response = await fetch("https://api.tavily.com/extract", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              api_key: tavilyApiKey,
              urls: urlQueries,
            }),
          });

          if (!response.ok) {
            console.error("Tavily Extract API error:", await response.text());
            return;
          }

          const data = await response.json();
          if (data.results) {
            aggregatedResults = aggregatedResults.concat(data.results);
          }
        })(),
      );
    }

    // 2. Process Text queries with the Search API
    if (textQueries.length > 0) {
      textQueries.forEach((query: string) => {
        promises.push(
          (async () => {
            const payload: Record<string, unknown> = {
              api_key: tavilyApiKey,
              query: query,
              search_depth: searchDepth,
              include_raw_content: includeRawContent,
              max_results: maxResults || 5,
              chunks_per_source:
                maxChunksPerSource && type === "advanced"
                  ? maxChunksPerSource
                  : undefined,
            };

            const response = await fetch("https://api.tavily.com/search", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
              },
              body: JSON.stringify(payload),
            });

            if (!response.ok) {
              console.error(
                `Tavily API error for query "${query}":`,
                await response.text(),
              );
              return;
            }

            const data = await response.json();
            aggregatedResults.push({
              query,
              results: data.results || [],
            });
          })(),
        );
      });
    }

    // Wait for all requests to finish
    await Promise.all(promises);

    const uniqueResultsMap = new Map<string, any>();

    for (const item of aggregatedResults) {
      // Handle Search API results (grouped by query)
      if (item.query && Array.isArray(item.results)) {
        for (const result of item.results) {
          if (!result.url) continue;

          if (uniqueResultsMap.has(result.url)) {
            const existing = uniqueResultsMap.get(result.url);

            // Track matched queries
            if (!existing.matched_queries) existing.matched_queries = [];
            if (!existing.matched_queries.includes(item.query)) {
              existing.matched_queries.push(item.query);
            }

            // Concatenate novel snippets
            if (result.content && existing.content && !existing.content.includes(result.content)) {
              existing.content += `\n...\n${result.content}`;
            } else if (result.content && !existing.content) {
              existing.content = result.content;
            }

            // Keep the highest score to reflect relevance
            if (result.score && (!existing.score || result.score > existing.score)) {
              existing.score = result.score;
            }

            // Retain raw content if fetched
            if (result.raw_content && !existing.raw_content) {
              existing.raw_content = result.raw_content;
            }

          } else {
            uniqueResultsMap.set(result.url, {
              ...result,
              matched_queries: [item.query],
            });
          }
        }
      }
      // Handle Extract API results (flat structure)
      else if (item.url) {
        if (uniqueResultsMap.has(item.url)) {
          const existing = uniqueResultsMap.get(item.url);

          if (!existing.matched_queries) existing.matched_queries = [];
          if (!existing.matched_queries.includes("extract")) {
            existing.matched_queries.push("extract");
          }

          if (item.raw_content && !existing.raw_content) {
            existing.raw_content = item.raw_content;
          }
        } else {
          uniqueResultsMap.set(item.url, {
            ...item,
            matched_queries: ["extract"],
          });
        }
      }
    }

    const finalResults = Array.from(uniqueResultsMap.values());

    return NextResponse.json({ results: finalResults });
  } catch (error: any) {
    console.error("Tavily Route Error:", error);
    return NextResponse.json(
      { error: "Failed to fetch Tavily API" },
      { status: 500 },
    );
  }
}
