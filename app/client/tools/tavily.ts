import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { useAccessStore, useChatStore } from "@/app/store";
import { fetch } from "@/app/utils/stream";

// Helper to remove `additionalProperties` which Google Gemini API strictly prohibits
function removeAdditionalProperties(schema: any): any {
  if (typeof schema !== "object" || schema === null) return schema;
  if ("additionalProperties" in schema) {
    delete schema.additionalProperties;
  }
  for (const key in schema) {
    removeAdditionalProperties(schema[key]);
  }
  return schema;
}

// --- Zod schema: single source of truth for tavily tool args ---
export const tavilyArgsSchema = z.object({
  queries: z
    .array(z.string())
    .min(1)
    .max(10)
    .describe(
      "A dynamic list of 1 to 10 distinct, keyword-dense search queries designed to cast a wide net for the user's prompt.",
    ),
});

export type TavilyArgs = z.infer<typeof tavilyArgsSchema>;

// --- Tool declaration (sent to LLM in the tools array) ---
export const tavilyToolDeclaration = {
  type: "function" as const,
  function: {
    name: "tavily_search",
    description:
      "Searches the web for real-time information. Requires an array of optimized search queries.",
    parameters: removeAdditionalProperties(
      zodToJsonSchema(tavilyArgsSchema as any, {
        $refStrategy: "none",
        target: "openApi3",
      }),
    ) as any,
  },
};

export const TAVILY_TOOL_NAME = "tavily_search";

// --- Validated handler factory ---
export interface TavilyHandlerConfig {
  tavilySearchType?: "basic" | "advanced" | "extract";
  tavilyMaxResults?: number;
  tavilyMaxChunksPerSource?: number;
}

export function createTavilyHandler(config: TavilyHandlerConfig) {
  let searchCount = 0;
  const MAX_SEARCHES = 4;

  return async (args: unknown): Promise<{ data: string }> => {
    if (searchCount >= MAX_SEARCHES) {
      return {
        data: JSON.stringify({
          error: `Maximum tavily_search attempts (${MAX_SEARCHES}) reached for this turn. Please stop searching and answer the user's prompt using the information you have already gathered.`,
        }),
      };
    }

    searchCount++;

    const parsed = tavilyArgsSchema.safeParse(args);

    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ");
      return {
        data: JSON.stringify({
          error: `Invalid tavily_search arguments: ${issues}`,
        }),
      };
    }

    const accessStore = useAccessStore.getState();
    const now = new Date();
    const currentMonth = `${now.getFullYear()}-${now.getMonth() + 1}`;

    let activeKeyIndex = accessStore.activeTavilyKeyIndex || 0;

    if (accessStore.lastTavilyRotationMonth !== currentMonth) {
      activeKeyIndex = 0;
      accessStore.update((access) => {
        access.activeTavilyKeyIndex = 0;
        access.lastTavilyRotationMonth = currentMonth;
      });
    }

    const apiRes = await fetch("/api/tavily", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        queries: parsed.data.queries,
        type: config.tavilySearchType,
        maxResults: config.tavilyMaxResults,
        maxChunksPerSource: config.tavilyMaxChunksPerSource,
        apiKey: accessStore.tavilyApiKey,
        activeKeyIndex: activeKeyIndex,
      }),
    });

    const data = await apiRes.json();

    if (
      data.updatedKeyIndex !== undefined &&
      data.updatedKeyIndex !== activeKeyIndex
    ) {
      accessStore.update((access) => {
        access.activeTavilyKeyIndex = data.updatedKeyIndex;
      });
    }

    const result: Record<string, unknown> = {
      results: data.results || [],
    };
    if (data.failedQueries?.length > 0) {
      result.failedQueries = data.failedQueries;
      result.error = data.error;
    }

    return { data: JSON.stringify(result) };
  };
}

// --- Retrieve Tool ---
export const tavilyRetrieveSchema = z.object({
  turn_id: z
    .string()
    .describe(
      "The ID of the interaction turn you want to retrieve the massive search payload for.",
    ),
});

export const tavilyRetrieveDeclaration = {
  type: "function" as const,
  function: {
    name: "tavily_retrieve",
    description:
      "Retrieves the full raw JSON text of a previous web search or extraction you performed in a past turn. Use the turn_id provided in your system logs.",
    parameters: removeAdditionalProperties(
      zodToJsonSchema(tavilyRetrieveSchema as any, {
        $refStrategy: "none",
        target: "openApi3",
      }),
    ) as any,
  },
};

export const TAVILY_RETRIEVE_TOOL_NAME = "tavily_retrieve";

export function createTavilyRetrieveHandler() {
  return async (args: unknown): Promise<{ data: string }> => {
    const parsed = tavilyRetrieveSchema.safeParse(args);
    if (!parsed.success) {
      return { data: JSON.stringify({ error: "Invalid turn_id arguments" }) };
    }

    const session = useChatStore.getState().currentSession();
    const message = session.messages.find((m) => m.id === parsed.data.turn_id);

    if (!message || !message.tools || message.tools.length === 0) {
      return {
        data: JSON.stringify({ error: "No tool data found for that turn." }),
      };
    }

    return { data: JSON.stringify(message.tools) };
  };
}
