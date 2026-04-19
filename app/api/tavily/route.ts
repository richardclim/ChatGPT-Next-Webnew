import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const {
      queries,
      type,
      maxResults,
      maxChunksPerSource,
      apiKey,
      activeKeyIndex = 0,
    } = body;

    const tavilyApiKey = apiKey || process.env.TAVILY_API_KEY;

    if (!tavilyApiKey) {
      return NextResponse.json(
        { error: "Tavily API key is missing." },
        { status: 401 },
      );
    }

    const allKeys = tavilyApiKey
      .split(",")
      .map((k: string) => k.trim())
      .filter(Boolean);
    if (allKeys.length === 0) {
      return NextResponse.json(
        { error: "No valid Tavily API keys found." },
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

    // Split queries into URLs and text searches robustly (handle whitespace/embedded quotes from LLMs)
    const isUrl = (q: string) => {
      const clean = q.trim().replace(/^['"]+|['"]+$/g, "");
      return clean.startsWith("http://") || clean.startsWith("https://");
    };

    const urlQueries = queries
      .filter((q: string) => isUrl(q))
      .map((q: string) => q.trim().replace(/^['"]+|['"]+$/g, ""));

    const textQueries = queries
      .filter((q: string) => !isUrl(q))
      .map((q: string) => q.trim().replace(/^['"]+|['"]+$/g, ""));

    let aggregatedResults: any[] = [];
    const failedQueries: string[] = [];
    const promises: Promise<void>[] = [];

    let sharedKeyIndex = activeKeyIndex < allKeys.length ? activeKeyIndex : 0;

    const tavilyFetch = async (url: string, payload: any) => {
      let attempts = 0;
      let localIndex = sharedKeyIndex;

      while (attempts < allKeys.length) {
        const key = allKeys[localIndex];
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...payload, api_key: key }),
        });

        if (res.ok) {
          sharedKeyIndex = localIndex; // update the shared index to the first successful key
          return res;
        }

        const errText = await res.text();
        console.error(
          `Tavily API error with key at index ${localIndex}:`,
          errText,
        );

        // If it's a 4xx error (Credit limit / Rate limit)
        if (res.status >= 400 && res.status < 500) {
          localIndex = (localIndex + 1) % allKeys.length;
          attempts++;
        } else {
          break; // For 500s, usually an internal server error, not a rotation issue.
        }
      }
      return null;
    };

    // 1. Process URL queries with the Extract API
    if (urlQueries.length > 0) {
      promises.push(
        (async () => {
          const response = await tavilyFetch("https://api.tavily.com/extract", {
            urls: urlQueries,
          });

          if (!response) {
            console.error("Tavily Extract API exhausted all keys or failed.");
            failedQueries.push("extract");
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
              query: query,
              search_depth: searchDepth,
              include_raw_content: includeRawContent,
              max_results: maxResults || 5,
              chunks_per_source:
                maxChunksPerSource && type === "advanced"
                  ? maxChunksPerSource
                  : undefined,
            };

            const response = await tavilyFetch(
              "https://api.tavily.com/search",
              payload,
            );

            if (!response) {
              console.error(
                `Tavily API exhausted all keys or failed for query "${query}"`,
              );
              failedQueries.push(query);
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
    const MAX_CONTENT_LENGTH = 20000;

    const getDeduplicationKey = (urlString: string) => {
      try {
        const parsedUrl = new URL(urlString);
        const trackingParams = [
          "srsltid",
          "gclid",
          "fbclid",
          "msclkid",
          "utm_source",
          "utm_medium",
          "utm_campaign",
          "utm_term",
          "utm_content",
          "igshid",
        ];
        trackingParams.forEach((param) => parsedUrl.searchParams.delete(param));
        parsedUrl.hash = ""; // Remove fragments as they often point to the same document
        return parsedUrl.toString();
      } catch (e) {
        // Fallback if URL is malformed
        return urlString;
      }
    };

    for (const item of aggregatedResults) {
      // Handle Search API results (grouped by query)
      if (item.query && Array.isArray(item.results)) {
        for (const result of item.results) {
          if (!result.url) continue;

          if (
            result.raw_content &&
            result.raw_content.length > MAX_CONTENT_LENGTH
          ) {
            result.raw_content =
              result.raw_content.slice(0, MAX_CONTENT_LENGTH) +
              "\n\n...[Extracted content truncated at 20k characters for length]";
          }

          const dedupKey = getDeduplicationKey(result.url);

          if (uniqueResultsMap.has(dedupKey)) {
            const existing = uniqueResultsMap.get(dedupKey);

            // Track matched queries
            if (!existing.matched_queries) existing.matched_queries = [];
            if (!existing.matched_queries.includes(item.query)) {
              existing.matched_queries.push(item.query);
            }

            // Concatenate novel snippets
            if (
              result.content &&
              existing.content &&
              !existing.content.includes(result.content)
            ) {
              existing.content += `\n...\n${result.content}`;
            } else if (result.content && !existing.content) {
              existing.content = result.content;
            }

            // Keep the highest score to reflect relevance
            if (
              result.score &&
              (!existing.score || result.score > existing.score)
            ) {
              existing.score = result.score;
            }

            // Retain raw content if fetched
            if (result.raw_content && !existing.raw_content) {
              existing.raw_content = result.raw_content;
            }
          } else {
            uniqueResultsMap.set(dedupKey, {
              ...result,
              matched_queries: [item.query],
            });
          }
        }
      }
      // Handle Extract API results (flat structure)
      else if (item.url) {
        if (item.raw_content && item.raw_content.length > MAX_CONTENT_LENGTH) {
          item.raw_content =
            item.raw_content.slice(0, MAX_CONTENT_LENGTH) +
            "\n\n...[Extracted content truncated at 20k characters for length]";
        }

        const dedupKey = getDeduplicationKey(item.url);

        if (uniqueResultsMap.has(dedupKey)) {
          const existing = uniqueResultsMap.get(dedupKey);

          if (!existing.matched_queries) existing.matched_queries = [];
          if (!existing.matched_queries.includes("extract")) {
            existing.matched_queries.push("extract");
          }

          if (item.raw_content && !existing.raw_content) {
            existing.raw_content = item.raw_content;
          }
        } else {
          uniqueResultsMap.set(dedupKey, {
            ...item,
            matched_queries: ["extract"],
          });
        }
      }
    }

    const finalResults = Array.from(uniqueResultsMap.values());

    return NextResponse.json({
      results: finalResults,
      updatedKeyIndex: sharedKeyIndex,
      ...(failedQueries.length > 0 && {
        failedQueries,
        error:
          "Some queries failed because all Tavily API keys are exhausted or invalid. Please check your API key configuration.",
      }),
    });
  } catch (error: any) {
    console.error("Tavily Route Error:", error);
    return NextResponse.json(
      { error: "Failed to fetch Tavily API" },
      { status: 500 },
    );
  }
}
