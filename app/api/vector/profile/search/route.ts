import { NextRequest, NextResponse } from "next/server";
import { searchProfileTable } from "../../store";
import { auth } from "../../../auth";
import { ModelProvider } from "@/app/constant";

export async function POST(req: NextRequest) {
  const authResult = auth(req, ModelProvider.GeminiPro);
  if (authResult.error) {
    return NextResponse.json(authResult, { status: 401 });
  }

  try {
    const { queries } = await req.json();
    if (!queries || !Array.isArray(queries)) {
      return NextResponse.json({ error: "Missing queries array" }, { status: 400 });
    }

    const allResultSets = await Promise.all(
      queries.map((q: string) => searchProfileTable(q))
    );
    
    const flattened = allResultSets.flat();
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
  } catch (e) {
    console.error("Profile Search Error", e);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 }
    );
  }
}
