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
    const { query, limit } = body;
    if (!query)
      return NextResponse.json({ error: "Missing query" }, { status: 400 });

    const results = await searchMemory(query, limit || 30);
    return NextResponse.json({ results });
  } catch (e) {
    console.error("Vector Search Error", e);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 },
    );
  }
}
