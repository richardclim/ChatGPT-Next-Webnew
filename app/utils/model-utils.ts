/**
 * GPT-5 model variant information for unified handling across API formats.
 */
export interface Gpt5ModelInfo {
  normalizedModel: string;
  isGpt5: boolean;
  isGpt52: boolean;
  isGpt5Mini: boolean;
  reasoningEffort:
    | "none"
    | "low"
    | "minimal"
    | "medium"
    | "high"
    | "xhigh"
    | undefined;
  verbosity: "low" | "medium" | "high" | undefined;
}

/**
 * Parse a GPT-5 model name to extract reasoning effort and other settings.
 * This is used by both client-side (openai.ts) and server-side (upsert/route.ts)
 * to ensure consistent handling of GPT-5 model variants.
 */
export function parseGpt5Model(model: string): Gpt5ModelInfo {
  const isGpt5 = model.startsWith("gpt-5");

  // For non-GPT-5 models, just pass through unchanged
  if (!isGpt5) {
    return {
      normalizedModel: model,
      isGpt5: false,
      isGpt52: false,
      isGpt5Mini: false,
      reasoningEffort: undefined,
      verbosity: undefined,
    };
  }

  // GPT-5 family specific handling
  const isGpt52 = model.startsWith("gpt-5.2");
  const isGpt5MiniLow = model === "gpt-5-mini-low";
  const isGpt5MiniMedium = model === "gpt-5-mini-medium";
  const isGpt5Mini = model.startsWith("gpt-5-mini");

  // Normalize model name by stripping reasoning effort suffixes
  let normalizedModel = model;
  if (isGpt5MiniLow || isGpt5MiniMedium) {
    normalizedModel = "gpt-5-mini";
  }

  // Determine reasoning effort based on model variant
  let reasoningEffort: Gpt5ModelInfo["reasoningEffort"] = "high";
  if (isGpt52) {
    reasoningEffort = "xhigh";
  } else if (isGpt5MiniMedium) {
    reasoningEffort = "medium";
  } else if (isGpt5MiniLow) {
    reasoningEffort = "low";
  }

  // Determine verbosity based on model
  const verbosity: Gpt5ModelInfo["verbosity"] = isGpt5Mini ? "medium" : "high";

  return {
    normalizedModel,
    isGpt5,
    isGpt52,
    isGpt5Mini,
    reasoningEffort,
    verbosity,
  };
}

import {
  MODEL_MAX_OUTPUT_TOKENS,
  DEFAULT_MAX_OUTPUT_TOKENS,
} from "@/app/constant";

/**
 * Look up the max output token limit for a given model name.
 * Returns the first matching limit from MODEL_MAX_OUTPUT_TOKENS,
 * or DEFAULT_MAX_OUTPUT_TOKENS if no match is found.
 */
export function getModelMaxOutputTokens(model: string): number {
  for (const [regex, limit] of MODEL_MAX_OUTPUT_TOKENS) {
    if (regex.test(model)) {
      return limit;
    }
  }
  return DEFAULT_MAX_OUTPUT_TOKENS;
}
