import { NextRequest, NextResponse } from "next/server";
import { upsertProfileChunks } from "../../store";
import { auth } from "../../../auth";
import { ModelProvider } from "@/app/constant";

export async function POST(req: NextRequest) {
  const authResult = auth(req, ModelProvider.GeminiPro);
  if (authResult.error) {
    return NextResponse.json(authResult, { status: 401 });
  }
  
  try {
    const { upserts = [], deletes = [] } = await req.json();
    await upsertProfileChunks(upserts, deletes);
    return NextResponse.json({ success: true });
  } catch(e) {
    console.error("Profile Upsert Error", e);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
