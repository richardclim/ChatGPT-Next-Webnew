import { createPersistStore } from "../utils/store";
import { StoreKey } from "../constant";
import { ModelConfig, ModelType } from "./config";
import { ChatMessage, createMessage } from "./chat";
import { getClientApi } from "../client/api";
import { ServiceProvider } from "../constant";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  extractFirstJsonObject,
  extractFirstJsonArray,
} from "../utils/json-parser";
import { parseThinkingContent } from "../utils";
import { nanoid } from "nanoid";

const profileUpdatesSchema = z
  .object({
    category: z
      .string()
      .describe("The high-level category (e.g., 'coding', 'personal')"),
    attribute: z
      .string()
      .describe("The specific attribute name (e.g., 'language', 'hobby')"),
    value: z
      .array(z.string())
      .describe(
        "The value(s) of the attribute. Always return an array of strings. If the output is only one value, wrap it in an array.",
      ),
    action: z
      .enum(["add", "replace", "delete"])
      .describe(
        "The type of update to perform. 'add' to append new values to a list, 'replace' to overwrite existing values entirely, 'delete' to remove the attribute.",
      ),
  })
  .strict();

export const memorySchema = z
  .object({
    profile_updates: z
      .array(profileUpdatesSchema)
      .describe(
        "List of new or changed facts about the user. Only include CHANGED or NEW facts.",
      ),
    episodic_summary: z
      .string()
      .describe(
        "A narrative summary of the conversation for long-term memory.",
      ),
    keywords: z
      .array(z.string())
      .describe(
        "Extract high-value search terms, topics, or entities discussed in the conversation. These should be relevant to the conversation and help with future context retrieval, used for vectorDB metadata.",
      ),
    is_continuation: z
      .boolean()
      .describe(
        "Set to true if the new messages continue the same topic as the PREVIOUS SUMMARY " +
          "and the episodic_summary is an updated/extended version. " +
          "Set to false if this is a new or distinct topic.",
      ),
  })
  .strict();

const rerankSchema = z.array(z.number().int());

const memoryJsonSchemaCache = zodToJsonSchema(memorySchema as any) as any;
const rerankJsonSchemaCache = zodToJsonSchema(rerankSchema as any) as any;

export interface ExtractionResult {
  lastMessageId: string;
  episodicSummary?: string;
  entryId?: string;
}

export function buildExtractionPrompt(
  today: string,
  profileJson: string,
  chatTranscript: string,
  previousSummary?: string,
): string {
  let prompt = `
      You are a Archivist, responsible for organizing user memory from the chat session. 
      Current Date: ${today}

      --- INPUT DATA ---
      EXISTING PROFILE (JSON):
      ${profileJson}

      NEW CHAT SESSION:
      ${chatTranscript}

      --- INSTRUCTIONS ---
      PART 1: User Profile Extraction (JSON)
      RULES:
      1. **Goal:** Extract permanent and/or actionable facts about the user to UPDATE their profile.
      2. **IGNORE:** Temporary states (hunger, mood, etc.), immediate needs, or generic greetings.
      3. **Conflict Resolution:** If new info contradicts the Existing Profile, trust the NEW information.
      4. **New Information:** If a fact is entirely new, add it to the profile. 
      5. **"category":** The broad domain (e.g., "coding", "personal", "health").
      6. **"attribute":** The specific variable name (e.g., "language", "city", "allergies").
      7. **"value":** The factual value(s) as an array of strings. 
      8. **"action":** Specify the operation:
         - "add": to append new elements to an ongoing list (e.g., learned a new programming language).
         - "replace": to completely overwrite a singular fact (e.g., changed address, updated age).
         - "delete": to remove specific elements from a list (provide the elements in "value"), or to remove the entire fact completely (provide an empty array [] for "value").

      PART 2: "episodic_summary" (STRING)
      1. **Goal:** Create a descriptive, narrative summary of the conversation for episodic memory. This summary should capture the essence and key takeaways for future LLM context retrieval. 
      2. **Content:** Focus on the USER's goals, the problem discussed, the solutions proposed, and any specific entities or topics of interest.
      3. **Contextualization:** If the conversation references past topics or user history, explicitly mention that connection (e.g., "User referenced their previous project on X"). 
      4. **Temporal Grounding:** Use the current data to make relative dates absolute. (e.g., "tomorrow" will be converted to the absolute date based on the current date provided)
      5. **DO NOT** include keywords, tags, or keyword lists inside the episodic_summary. The summary must be pure narrative only.

      PART 3: "keywords" (ARRAY OF STRINGS)
      1. Extract high-value search terms, topics, technologies, and entities discussed in the conversation.
      2. These MUST be placed in the "keywords" array field, NOT inside the episodic_summary text.
      3. Always return at least a few keywords. Never return an empty array if the conversation has any substance.
      `;

  if (previousSummary) {
    prompt += `
--- PREVIOUS SUMMARY ---
${previousSummary}

--- CONTINUATION INSTRUCTIONS ---
If the NEW CHAT SESSION continues the same topic as the PREVIOUS SUMMARY:
  - Set is_continuation to true
  - Produce an updated/extended episodic_summary that incorporates both the previous and new information
If the NEW CHAT SESSION introduces a genuinely new or distinct topic:
  - Set is_continuation to false
  - Produce a standalone episodic_summary for the new topic only
`;
  } else {
    prompt += `
There is no previous summary. Always set is_continuation to false.
`;
  }

  return prompt;
}

export function buildUpsertChunk(
  sessionId: string,
  enrichedContent: string,
  keywords: string[],
  createdAt: number,
  isContinuation: boolean,
  lastEpisodicEntryId?: string,
): Record<string, unknown> {
  return {
    id: nanoid(),
    sessionIds: [sessionId],
    content: enrichedContent,
    keywords,
    createdAt,
    ...(isContinuation && lastEpisodicEntryId
      ? { replaceEntryId: lastEpisodicEntryId }
      : {}),
  };
}

export type MemoryConfig = Partial<ModelConfig> & {
  model: ModelType;
  providerName: ServiceProvider;
};

export interface MemoryStore {
  enabled: boolean;
  enableContextInjectionDisplay: boolean;
  content: UserProfile;
  memoryModelConfig: MemoryConfig;

  setEnabled: (enabled: boolean) => void;
  setEnableContextInjectionDisplay: (enabled: boolean) => void;
  updateContent: (content: UserProfile) => void;
  updateMemoryModelConfig: (updater: (config: MemoryConfig) => void) => void;
  processExtraction: (
    messages: ChatMessage[],
    sessionId: string,
    lastArchivedContextId?: string,
    previousSummary?: string,
    lastEpisodicEntryId?: string,
  ) => Promise<ExtractionResult | undefined>;
  findRelevant: (
    query: string,
    previousMemoryContexts?: string[],
  ) => Promise<string>;
  retrieveEpisodicMemory: (
    query: string,
    limit?: number,
    recentHistory?: ChatMessage[],
    previousMemoryContexts?: string[],
  ) => Promise<string[]>;
}

interface VectorSearchResult {
  results: any[];
}

interface UserProfile {
  [key: string]: any;
}

export const useMemoryStore = createPersistStore(
  {
    enabled: true,
    enableContextInjectionDisplay: false,
    content: {} as UserProfile,
    memoryModelConfig: {
      model: "gpt-4o-mini",
      providerName: "OpenAI",
      temperature: 1,
      reasoningEffort: "",
    } as MemoryConfig,
  },
  (set, _get) => {
    function get() {
      return {
        ..._get(),
        ...methods,
      };
    }

    const methods = {
      setEnabled(enabled: boolean) {
        set(() => ({ enabled }));
      },

      setEnableContextInjectionDisplay(enabled: boolean) {
        set(() => ({ enableContextInjectionDisplay: enabled }));
      },

      updateContent(content: UserProfile) {
        get().update((state) => {
          state.content = content;
        });
      },

      updateMemoryModelConfig(updater: (config: MemoryConfig) => void) {
        get().update((state) => {
          updater(state.memoryModelConfig);
        });
      },

      async processExtraction(
        messages: ChatMessage[],
        sessionId: string,
        lastArchivedContextId?: string,
        previousSummary?: string,
        lastEpisodicEntryId?: string,
      ): Promise<ExtractionResult | undefined> {
        if (!get().enabled || messages.length === 0) return undefined;

        // Filter to only process messages after the last archived one
        const archiveIndex = lastArchivedContextId
          ? messages.findIndex((m) => m.id === lastArchivedContextId)
          : -1;

        let newMessages = messages;
        if (lastArchivedContextId) {
          if (archiveIndex !== -1) {
            newMessages = messages.slice(archiveIndex + 1);
          } else {
            console.warn(
              "[Memory] lastArchivedContextId not found in messages. Processing all available messages to recover state.",
            );
            // newMessages remains `messages` to recover state
          }
        }

        if (newMessages.length === 0) {
          console.log("[Memory] No new messages to extract");
          return undefined;
        }

        // Get the ID of the last message we're about to process
        const lastMessageId = newMessages[newMessages.length - 1]?.id;
        if (!lastMessageId) {
          console.log("[Memory] No valid last message ID");
          return undefined;
        }

        // 1. Existing Profile Extraction
        const config = get().memoryModelConfig;
        const api = getClientApi(config.providerName as ServiceProvider);

        const geminiJsonMode = config.providerName === "Google";
        const openAIJsonMode =
          config.providerName === "OpenAI" || config.providerName === "Azure";

        const today = new Date().toLocaleDateString("en-US", {
          weekday: "long",
          year: "numeric",
          month: "long",
          day: "numeric",
        });

        const chatTranscript = newMessages
          .filter((m) => m.role === "user" || m.role === "assistant")
          .map((m) => {
            const content =
              m.role === "assistant" && typeof m.content === "string"
                ? parseThinkingContent(m.content).output
                : m.content;
            return `${m.role.toUpperCase()}: ${content}`;
          })
          .join("\n");

        const prompt = buildExtractionPrompt(
          today,
          JSON.stringify(get().content, null, 2),
          chatTranscript,
          previousSummary,
        );
        // For future considerations **Preservation:** If the user provided specific code snippets, configuration data, or step-by-step instructions, preserve them VERBATIM within the summary.

        return new Promise<ExtractionResult | undefined>((resolve) => {
          try {
            api.llm.chat({
              messages: [createMessage({ role: "system", content: prompt })],
              config: {
                ...config,
                temperature: 1, // Hardcoded fallback for deterministic memory extraction
                max_tokens: 0, // Bypass chat-level token limits
                stream: false,
                useStandardCompletion: true,
                suppressReasoningOutput: true, // Get reasoning quality without reasoning text in response
                responseMimeType: geminiJsonMode
                  ? "application/json"
                  : undefined,
                responseJsonSchema: geminiJsonMode
                  ? memoryJsonSchemaCache
                  : undefined,
                response_format: openAIJsonMode
                  ? {
                      type: "json_schema",
                      json_schema: {
                        name: "memory_extraction",
                        schema: memoryJsonSchemaCache,
                        strict: true,
                      },
                    }
                  : undefined,
              },
              onFinish(message, responseRes) {
                if (responseRes?.status === 200 && message) {
                  try {
                    const combinedResult = extractFirstJsonObject(message);
                    if (!combinedResult) {
                      console.log("[Memory] No JSON object found in response");
                      resolve(undefined);
                      return;
                    }

                    const {
                      profile_updates = {},
                      episodic_summary: expected_summary = "",
                      keywords: rawKeywords = [],
                      is_continuation = false,
                    } = combinedResult as any;
                    const episodic_summary = expected_summary || (combinedResult as any).episodic_history_summary || "";
                    const keywords = rawKeywords as string[];

                    // 1. Handle Profile Updates
                    if (
                      Array.isArray(profile_updates) &&
                      profile_updates.length > 0
                    ) {
                      // Deep clone the existing profile
                      const existingProfile = get().content;
                      const newProfile = JSON.parse(
                        JSON.stringify(existingProfile),
                      );

                      for (const update of profile_updates) {
                        const category = update.category || update.Category;
                        const attribute = update.attribute || update.Attribute;
                        const value = update.value || update.Value;
                        const action = String(update.action || update.Action || "add").toLowerCase();
                        
                        if (!category || !attribute) continue;

                        if (!newProfile[category]) {
                          newProfile[category] = {};
                        }

                        const existingVal = newProfile[category][attribute];

                        if (action === "delete") {
                          if (
                            Array.isArray(existingVal) &&
                            Array.isArray(value) &&
                            value.length > 0
                          ) {
                            // Filter out the requested values from the existing array
                            const filtered = existingVal.filter(
                              (item) => !value.includes(String(item)),
                            );
                            if (filtered.length === 0) {
                              delete newProfile[category][attribute];
                            } else {
                              newProfile[category][attribute] = filtered;
                            }
                          } else {
                            // Either 'value' is empty [] or 'existingVal' is a scalar/undefined. 
                            // Delete the entire attribute completely.
                            delete newProfile[category][attribute];
                          }

                          // Clean up empty categories directly
                          if (
                            newProfile[category] &&
                            Object.keys(newProfile[category]).length === 0
                          ) {
                            delete newProfile[category];
                          }
                        } else if (action === "replace") {
                          // Completely overwrite the existing value
                          newProfile[category][attribute] = value;
                        } else {
                          // action === "add"
                          if (existingVal === undefined) {
                            newProfile[category][attribute] = value;
                          } else if (
                            Array.isArray(existingVal) &&
                            Array.isArray(value)
                          ) {
                            // Both arrays - merge and deduplicate
                            newProfile[category][attribute] = [
                              ...new Set([...existingVal, ...value]),
                            ];
                          } else if (
                            !Array.isArray(existingVal) &&
                            existingVal !== undefined &&
                            Array.isArray(value)
                          ) {
                            // Legacy migration: existing is non-array, new is array
                            // Convert existing to array and merge
                            newProfile[category][attribute] = [
                              ...new Set([String(existingVal), ...value]),
                            ];
                          } else {
                            // Fallback for non-arrays when adding
                            newProfile[category][attribute] = value;
                          }
                        }
                      }

                      get().updateContent(newProfile);
                      console.log(
                        "[Memory] Profile updated successfully",
                        profile_updates,
                      );
                    } else {
                      console.log("[Memory] No profile updates needed");
                    }

                    // 2. Handle Episodic Summary Archiving (Vector DB)
                    // Only update lastArchivedContextId if episodic archiving succeeds
                    if (episodic_summary) {
                      const enrichedContent = `
                            ${episodic_summary}
                            Keywords: ${keywords.join(", ")}
                            `.trim();
                      const chunk = buildUpsertChunk(
                        sessionId,
                        enrichedContent,
                        keywords,
                        Date.now(),
                        Boolean(is_continuation),
                        lastEpisodicEntryId,
                      );

                      // Make upsert blocking - only mark as archived if successful
                      fetch("/api/vector/upsert", {
                        method: "POST",
                        body: JSON.stringify({
                          chunks: [chunk],
                          provider: config.providerName,
                          model: config.model,
                          reasoningEffort: config.reasoningEffort,
                        }),
                        headers: {
                          "Content-Type": "application/json",
                        },
                      })
                        .then(async (res) => {
                          if (res.ok) {
                            const responseData = await res.json();
                            const entryId = responseData?.entryId;
                            console.log("[Memory] Episodic summary archived");
                            console.log(
                              "[Memory] Extraction complete, lastMessageId:",
                              lastMessageId,
                            );
                            resolve({
                              lastMessageId,
                              episodicSummary: String(episodic_summary),
                              entryId,
                            });
                          } else {
                            res.text().then((body) => {
                              console.error(
                                `[Memory] Episodic archiving failed with status: ${res.status}`,
                                body,
                              );
                            });
                            resolve(undefined);
                          }
                        })
                        .catch((e) => {
                          console.error(
                            "[Memory] Episodic archiving failed",
                            e,
                          );
                          resolve(undefined);
                        });
                    } else {
                      // No episodic summary to archive - still consider extraction successful
                      // but only if profile updates were made
                      if (
                        Array.isArray(profile_updates) &&
                        profile_updates.length > 0
                      ) {
                        console.log(
                          "[Memory] No episodic summary, but profile updated. Marking as archived.",
                        );
                        resolve({ lastMessageId });
                      } else {
                        console.log(
                          "[Memory] No episodic summary and no profile updates.",
                        );
                        resolve({ lastMessageId });
                      }
                    }
                  } catch (parseError) {
                    console.error("[Memory] Failed to parse JSON", parseError);
                    resolve(undefined);
                  }
                } else {
                  console.error(
                    `[Memory] Extraction failed with status: ${
                      responseRes?.status ?? "unknown"
                    }`,
                  );
                  resolve(undefined);
                }
              },
              onError(err) {
                console.error("[Memory] Extraction failed", err);
                resolve(undefined);
              },
            });
          } catch (e) {
            console.error("[Memory] Extraction Exception", e);
            resolve(undefined);
          }
        });
      },

      async retrieveEpisodicMemory(
        query: string,
        limit: number = 5,
        recentHistory: ChatMessage[] = [],
        previousMemoryContexts: string[] = [],
      ): Promise<string[]> {
        if (!get().enabled) return [];

        const config = get().memoryModelConfig;
        const api = getClientApi(config.providerName as ServiceProvider);
        const today = new Date().toLocaleString();

        const geminiJsonMode = config.providerName === "Google";
        const openAIJsonMode =
          config.providerName === "OpenAI" || config.providerName === "Azure";

        const expansionPrompt = `
            Current Date: ${today}
            
            REFERENCE CONTEXT (use ONLY to resolve ambiguous references like "it", "that", "the error"):
            ${
              recentHistory.filter(
                (m) => m.role === "user" || m.role === "assistant",
              ).length > 0
                ? recentHistory
                    .filter((m) => m.role === "user" || m.role === "assistant")
                    .map((m) => `${m.role}: ${m.content}`)
                    .join("\n")
                : "(none)"
            }

            USER QUERY (this is the SOLE focus of the search):
            "${query}"

            Task: Convert the USER QUERY into a specific, standalone search query for a Vector Database.
            1. The search query must be about the USER QUERY topic ONLY. Do NOT include topics from the Reference Context unless the User Query explicitly refers to them.
            2. Remove conversational filler.
            3. If the query implies a specific time (e.g., "yesterday"), convert to absolute date.
            4. Extract key entities and topics from the USER QUERY.
            5. Include specific keywords from the USER QUERY.
            6. RESOLVE REFERENCES: If the User Query contains pronouns like "it", "that", "this", or "the error", replace them with the specific entity from the Reference Context. If the User Query is already specific, IGNORE the Reference Context entirely.
            
            Return ONLY the optimized search string. No quotes.
        `;

        let optimizedQuery = query;

        try {
          await new Promise((resolve) => {
            api.llm.chat({
              messages: [
                createMessage({ role: "system", content: expansionPrompt }),
              ],
              config: {
                ...config,
                temperature: 1, // Hardcoded fallback for deterministic memory extraction
                max_tokens: 0, // Bypass chat-level token limits
                stream: false,
                useStandardCompletion: true,
                suppressReasoningOutput: true,
              },
              onFinish(message) {
                if (message && message.length > 0) {
                  optimizedQuery = message.trim();
                  console.log(
                    `[Memory] Query Expanded: "${query}" -> "${optimizedQuery}"`,
                  );
                }
                resolve(null);
              },
              onError() {
                resolve(null);
              },
            });
          });
        } catch (e) {
          console.warn("[Memory] Query expansion failed, using original query");
        }

        try {
          // 1. Vector/Hybrid Search
          const res = await fetch("/api/vector/search", {
            method: "POST",
            body: JSON.stringify({ query: optimizedQuery, limit: 30 }),
            headers: { "Content-Type": "application/json" },
          });
          const data = await res.json();
          const candidates = data.results as any[]; // Expected { content: string, id: string, ... }[]

          if (!candidates || candidates.length === 0) return [];

          // Filter out low-relevance results before reranking
          // _relevance_score is from hybrid/vector search — scores below 0.3 are essentially noise
          const relevantCandidates = candidates.filter(
            (c: any) =>
              c._relevance_score === undefined || c._relevance_score >= 0.3,
          );

          if (relevantCandidates.length === 0) return [];

          if (relevantCandidates.length <= limit) {
            // Still rerank with LLM even for small result sets to filter irrelevant content
            // Fall through to the reranker below instead of returning blindly
          }

          const candidatesList = relevantCandidates
            .map((c, i) => `ID: ${i}\nContent: ${c.content}`)
            .join("\n\n");

          const previousContextSection =
            previousMemoryContexts.length > 0
              ? `\n             ALREADY ATTACHED CONTEXT (from previous messages in this session):\n             ${previousMemoryContexts.join(
                  "\n---\n",
                )}\n`
              : "";

          const rerankPrompt = `
             Current Date: ${today}
             User Query: ${query}
             ${previousContextSection}
             Here are ${relevantCandidates.length} retrieval candidates from the database.
             Task: Select snippets that contain specific facts that can help answer the User Query in the current context. 

             CRITICAL RULES:
             1. RELEVANCE IS KEY: Only select snippets that are strictly relevant and helps answer the query. 
             2. IGNORE NOISE: If a snippet talks about a different topic, ignore it.
             3. CONTEXT AWARENESS: Use the Recent Context to disambiguate. (e.g. if Context is about "Production DB", ignore snippets about "Test DB").
             4. VALUE ADD: Prioritize snippets that add *new* details or specific facts not fully explained in the immediate history.
             5. DEDUPLICATION: If a snippet's content is already present in the ALREADY ATTACHED CONTEXT above, do NOT select it again.
             6. If the information from the snippets already exist in the recent history, ignore it.
             7. QUANTITY: You may select 0 to ${limit} snippets. Do NOT force yourself to pick ${limit} if they are not good.
             8. If NO snippets are relevant, return an empty array [].
             9. Return ONLY a JSON array of the matching IDs (integers). Example: [0, 5]
       
             Snippets:
             ${candidatesList}
             `;

          return new Promise((resolve) => {
            let finalChunks: string[] = [];
            api.llm.chat({
              messages: [
                createMessage({ role: "system", content: rerankPrompt }),
              ],
              config: {
                ...config,
                temperature: 1, // Hardcoded fallback for deterministic memory extraction
                max_tokens: 0, // Bypass chat-level token limits
                stream: false,
                useStandardCompletion: true,
                suppressReasoningOutput: true,
                responseMimeType: geminiJsonMode
                  ? "application/json"
                  : undefined,
                responseJsonSchema: geminiJsonMode
                  ? rerankJsonSchemaCache
                  : undefined,
                response_format: openAIJsonMode
                  ? {
                      type: "json_schema",
                      json_schema: {
                        name: "memory_extraction",
                        schema: rerankJsonSchemaCache,
                        strict: true,
                      },
                    }
                  : undefined,
              },
              onFinish(message) {
                try {
                  const indices = extractFirstJsonArray<number[]>(message);
                  if (indices) {
                    finalChunks = indices
                      .map((i) => relevantCandidates[i]?.content)
                      .filter((c) => !!c);
                  } else {
                    // Fallback: take top limit
                    finalChunks = relevantCandidates
                      .slice(0, limit)
                      .map((c: any) => c.content);
                  }
                } catch (e) {
                  finalChunks = relevantCandidates
                    .slice(0, limit)
                    .map((c: any) => c.content);
                }
                resolve(finalChunks);
              },
              onError(e) {
                console.error("[Memory] Rerank failed", e);
                resolve(
                  relevantCandidates.slice(0, limit).map((c: any) => c.content),
                );
              },
            });
          });
        } catch (e) {
          console.error("[Memory] RetrieveEpisodicMemory failed", e);
          return [];
        }
      },

      async findRelevant(
        query: string,
        previousMemoryContexts: string[] = [],
      ): Promise<string> {
        if (!get().enabled || Object.keys(get().content).length === 0)
          return "";

        const config = get().memoryModelConfig;
        const api = getClientApi(config.providerName as ServiceProvider);

        const previousContextSection =
          previousMemoryContexts.length > 0
            ? `\n      ALREADY ATTACHED CONTEXT (from previous messages in this session):\n      ${previousMemoryContexts.join(
                "\n---\n",
              )}\n`
            : "";

        const prompt = `
      User Profile (JSON):
      ${JSON.stringify(get().content, null, 2)}

      User Query:
      ${query}
      ${previousContextSection}
      Instruction:
      Select ONLY the facts from the User Profile that are DIRECTLY relevant to the User Query.
      DEDUPLICATION: If the facts are already present in the ALREADY ATTACHED CONTEXT above, do NOT include them again.
      Return them as a concise list.
      If nothing is relevant, or if all relevant facts are already in the attached context, return "NO_CONTEXT".
      `;

        return new Promise((resolve) => {
          let result = "";
          try {
            api.llm.chat({
              messages: [createMessage({ role: "system", content: prompt })],
              config: {
                ...config,
                temperature: 1, // Hardcoded fallback for deterministic memory extraction
                max_tokens: 0, // Bypass chat-level token limits
                stream: false,
                useStandardCompletion: true,
                suppressReasoningOutput: true,
              },
              onFinish(message, responseRes) {
                if (responseRes?.status === 200) {
                  result = message;
                }
                if (result === "NO_CONTEXT") {
                  result = "";
                }
                resolve(result);
              },
              onError(err) {
                console.error("[Memory] FindRelevant failed", err);
                resolve("");
              },
            });
          } catch (e) {
            console.error("[Memory] FindRelevant Exception", e);
            resolve("");
          }
        });
      },
    };

    return methods;
  },
  {
    name: StoreKey.Memory,
    version: 1,
  },
);
