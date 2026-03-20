import {
  MODEL_MAX_OUTPUT_TOKENS,
  MODEL_EFFORT_LEVELS,
  DEFAULT_MAX_OUTPUT_TOKENS,
} from "@/app/constant";

/**
 * GPT-5 model variant information for unified handling across API formats.
 */
export interface Gpt5ModelInfo {
  normalizedModel: string;
  isGpt5: boolean;
  isGpt5Mini: boolean;
  reasoningEffort: string | undefined;
  verbosity: "low" | "medium" | "high" | undefined;
}

/**
 * Parse a GPT-5 model name and resolve reasoning effort from config.
 * The `configEffort` parameter comes from ModelConfig.reasoningEffort.
 * Empty string or undefined means "use highest available".
 */
export function parseGpt5Model(
  model: string,
  configEffort?: string,
): Gpt5ModelInfo {
  const isGpt5 = model.startsWith("gpt-5");

  if (!isGpt5) {
    return {
      normalizedModel: model,
      isGpt5: false,
      isGpt5Mini: false,
      reasoningEffort: undefined,
      verbosity: undefined,
    };
  }

  const isGpt5Mini = model.includes("gpt-5-mini");

  // Resolve effort: use config value, or fall back to highest for this model
  const effortLevels = getModelEffortLevels(model);
  let reasoningEffort: string | undefined;
  if (configEffort) {
    reasoningEffort = configEffort;
  } else if (effortLevels && effortLevels.length > 0) {
    reasoningEffort = effortLevels[effortLevels.length - 1];
  } else {
    reasoningEffort = "xhigh";
  }

  const verbosity: Gpt5ModelInfo["verbosity"] = isGpt5Mini ? "medium" : "high";

  return {
    normalizedModel: model,
    isGpt5,
    isGpt5Mini,
    reasoningEffort,
    verbosity,
  };
}

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

/**
 * Get the supported reasoning effort levels for a model.
 * Returns the array of effort strings, or null if the model
 * does not support effort configuration.
 */
export function getModelEffortLevels(model: string): string[] | null {
  for (const [regex, levels] of MODEL_EFFORT_LEVELS) {
    if (regex.test(model)) {
      return levels.length > 0 ? levels : null;
    }
  }
  return null;
}

/**
 * Resolve the effective reasoning effort for a model.
 * If configEffort is set and non-empty, returns it.
 * Otherwise returns the highest available level, or undefined.
 */
export function resolveReasoningEffort(
  model: string,
  configEffort?: string,
): string | undefined {
  const levels = getModelEffortLevels(model);
  if (!levels) return undefined;
  if (configEffort) return configEffort;
  return levels[levels.length - 1]; // highest
}
