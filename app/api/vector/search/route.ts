import { NextRequest, NextResponse } from "next/server";
import { searchMemory } from "../store";
import { auth } from "../../auth";
import { ModelProvider } from "@/app/constant";

export async function POST(req: NextRequest) {
  const authResult = auth(req, ModelProvider.GeminiPro);
  if (authResult.error) {
    return NextResponse.json(authResult, { status: 401 });
  }

  try {
    const body = await req.json();
    const { query, queries } = body;

    // Handle object structure for decomposed hybrid search
    if (queries && typeof queries === 'object' && !Array.isArray(queries)) {
      const semantics = Array.isArray(queries.semantic) ? queries.semantic : [];
      const keywords = Array.isArray(queries.keyword) ? queries.keyword : [];
      const maxLength = Math.max(semantics.length, keywords.length);

      if (maxLength > 0) {
        // Execute all searches concurrently
        const allResultSets = await Promise.all(
          Array.from({ length: maxLength }).map((_, i) => {
            return searchMemory({
              semanticQuery: semantics[i] || (i === 0 ? query : ""),
              keywordQuery: keywords[i] || (i === 0 ? query : "")
            });
          })
        );
        
        // Flatten results
      const flattened = allResultSets.flat();
      
      // Deduplicate by result id
      const seen = new Set<string>();
      const deduped: Record<string, unknown>[] = [];
      for (const raw of flattened) {
        const r = raw as Record<string, unknown>;
        if (r && typeof r.id === "string" && !seen.has(r.id)) {
          seen.add(r.id);
          deduped.push(r);
        }
      }
        return NextResponse.json({ results: deduped });
      }
    }

    // Fallback for single query
    if (!query)
      return NextResponse.json({ error: "Missing query or queries" }, { status: 400 });

    const results = await searchMemory({ semanticQuery: query, keywordQuery: query });
    return NextResponse.json({ results });
  } catch (e) {
    console.error("Vector Search Error", e);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 },
    );
  }
}
