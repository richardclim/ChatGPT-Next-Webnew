import { NextRequest, NextResponse } from "next/server";
import { upsertMemory } from "../store";
import { auth } from "../../auth";
import { ModelProvider } from "@/app/constant";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { extractFirstJsonObject } from "@/app/utils/json-parser";
import {
  parseGpt5Model,
  resolveReasoningEffort,
} from "@/app/utils/model-utils";

const memoryActionSchema = z
  .object({
    action: z.enum(["INSERT", "MERGE", "IGNORE"]),
    mergedContent: z
      .string()
      .optional()
      .describe(
        "Required if action is MERGE. Format: 'Summary: [merged narrative]\\nKeywords: [comma-separated unique keywords]'",
      ),
  })
  .strict();

function getProviderPath(provider: string) {
  switch (provider) {
    case "Google":
      return "/api/google";
    case "OpenAI":
      return "/api/openai";
    case "Azure":
      return "/api/azure";
    case "Anthropic":
      return "/api/anthropic";
    default:
      return "/api/openai"; // Fallback or handle differently
  }
}

export async function POST(req: NextRequest) {
  const authResult = auth(req, ModelProvider.GeminiPro);
  if (authResult.error) {
    return NextResponse.json(authResult, { status: 401 });
  }

  try {
    const body = await req.json();
    const { chunks, provider, model, reasoningEffort } = body;

    // Build the LLM callback
    const askLLM = async (existing: string, newContent: string) => {
      const origin = req.nextUrl.origin;
      const apiPath = getProviderPath(provider);

      const prompt = `
      You are a memory manager for an AI episodic journal.
      I have an EXISTING memory and a NEW memory input. Each memory follows the format:
      "Summary: [narrative summary]
      Keywords: [comma-separated keywords]"
      
      EXISTING: "${existing}"
      NEW: "${newContent}"
      
      Decide the best action:
      1. IGNORE: The NEW memory adds absolutely no new information.
      2. MERGE: The NEW memory is a correction, clarification, or additional detail about the EXACT SAME specific event/topic as EXISTING.
      3. INSERT: The NEW memory is a distinct event, or a similar event happening at a different time, or a separate thought.
      
      If MERGE:
      - Combine the summaries into a single coherent narrative.
      - COMBINE all keywords from BOTH memories (deduplicate).
      - Preserve the format: "Summary: [merged summary]\\nKeywords: [all unique keywords]"
      `;

      let payload: any = {};
      let fetchUrl = `${origin}${apiPath}`;
      const jsonSchema = zodToJsonSchema(memoryActionSchema as any) as any;

      if (provider === "Google") {
        fetchUrl += `/v1beta/models/${model}:generateContent`;
        payload = {
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            responseMimeType: "application/json",
            responseSchema: jsonSchema,
          },
        };
      } else {
        fetchUrl += "/v1/chat/completions";

        const gpt5Info = parseGpt5Model(model || "", reasoningEffort);

        payload = {
          model: gpt5Info.normalizedModel,
          messages: [
            {
              role: "system",
              content: "You are a helpful assistant. Respond in JSON.",
            },
            { role: "user", content: prompt },
          ],
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "memory_action",
              schema: jsonSchema,
              strict: true,
            },
          },
          ...(gpt5Info.isGpt5 &&
            gpt5Info.reasoningEffort && {
              reasoning: {
                effort: gpt5Info.reasoningEffort,
                summary: "none",
              },
            }),
        };
      }

      const res = await fetch(fetchUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": req.headers.get("x-goog-api-key") || "",
          Authorization: req.headers.get("Authorization") || "",
          "api-key": req.headers.get("api-key") || "", // Azure
        },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const text = await res.text();
        console.error(`[Memory Router] LLM Call Failed: ${res.status} ${text}`);
        throw new Error(`LLM Call Failed: ${res.status}`);
      }

      const data = await res.json();

      let contentText = "";
      if (provider === "Google") {
        contentText = data.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
      } else {
        contentText = data.choices?.[0]?.message?.content || "{}";
      }

      const parsed = extractFirstJsonObject(contentText);
      if (parsed) {
        return parsed;
      }
      return JSON.parse(contentText);
    };

    if (!chunks || !Array.isArray(chunks)) {
      return NextResponse.json({ error: "Invalid body" }, { status: 400 });
    }

    const entryId = await upsertMemory(
      chunks,
      provider && model ? askLLM : undefined,
    );

    return NextResponse.json({ success: true, entryId });
  } catch (e) {
    console.error("Vector Upsert Error", e);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 },
    );
  }
}
