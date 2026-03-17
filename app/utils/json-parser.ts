/**
 * Safely extracts and parses the first valid JSON object or array from a string.
 * This is more robust than regex approaches like /\{[\s\S]*\}/ which are "greedy"
 * and may match from the first '{' to the LAST '}', potentially including
 * extra content if the LLM adds explanatory text after the JSON.
 *
 * This parser finds the first '{' or '[' and incrementally attempts to parse
 * substrings until it finds a valid JSON structure.
 *
 * @param text - The raw text that may contain JSON
 * @param type - 'object' to find first {...}, 'array' to find first [...], 'auto' to find either (object first)
 * @returns The parsed JSON value, or null if no valid JSON is found
 */
export function extractFirstJson<T = unknown>(
  text: string,
  type: "object" | "array" | "auto" = "auto",
): T | null {
  if (!text || typeof text !== "string") {
    return null;
  }

  const openBrackets =
    type === "array" ? ["["] : type === "object" ? ["{"] : ["{", "["];

  for (const openBracket of openBrackets) {
    const closeBracket = openBracket === "{" ? "}" : "]";
    const startIndex = text.indexOf(openBracket);

    if (startIndex === -1) {
      continue;
    }

    // Track bracket depth to find potential end points
    let depth = 0;
    let inString = false;
    let escapeNext = false;

    for (let i = startIndex; i < text.length; i++) {
      const char = text[i];

      if (escapeNext) {
        escapeNext = false;
        continue;
      }

      if (char === "\\") {
        escapeNext = true;
        continue;
      }

      if (char === '"') {
        inString = !inString;
        continue;
      }

      if (inString) {
        continue;
      }

      if (char === openBracket) {
        depth++;
      } else if (char === closeBracket) {
        depth--;

        if (depth === 0) {
          // Found a potential complete JSON structure
          const candidate = text.slice(startIndex, i + 1);
          try {
            const parsed = JSON.parse(candidate);
            // Verify it's the expected type
            if (type === "object" && typeof parsed !== "object") continue;
            if (type === "object" && Array.isArray(parsed)) continue;
            if (type === "array" && !Array.isArray(parsed)) continue;
            return parsed as T;
          } catch {
            // Not valid JSON, continue searching for the next closing bracket
            // Reset depth and continue from current position
            depth = 1;
          }
        }
      }
    }
  }

  return null;
}

/**
 * Convenience function to extract the first JSON object from text.
 */
export function extractFirstJsonObject<T = Record<string, unknown>>(
  text: string,
): T | null {
  return extractFirstJson<T>(text, "object");
}

/**
 * Convenience function to extract the first JSON array from text.
 */
export function extractFirstJsonArray<T = unknown[]>(text: string): T | null {
  return extractFirstJson<T>(text, "array");
}
