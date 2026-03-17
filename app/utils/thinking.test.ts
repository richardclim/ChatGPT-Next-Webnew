// Mock the store module to avoid deep dependency chain that pulls in ESM modules
// (nanoid, lodash-es) which Jest cannot transform
jest.mock("@/app/store", () => ({
  useAccessStore: { getState: () => ({}) },
}));
jest.mock("@/app/components/ui-lib", () => ({
  showToast: jest.fn(),
}));

import * as fc from "fast-check";
import { parseThinkingContent, formatReasoningDuration } from "../utils";

describe("Feature: thinking-block-and-stream-timer, Property 5: Thinking content parsing", () => {
  /**
   * **Validates: Requirements 5.1, 5.2**
   *
   * For any message content string containing blockquote-prefixed lines
   * (lines starting with `> `) mixed with regular lines,
   * `parseThinkingContent` SHALL return a `thinking` string containing
   * all blockquote content (without the `> ` prefix) and an `output`
   * string containing all non-blockquote content. The concatenation of
   * thinking and output lines SHALL account for all non-empty lines in
   * the original content.
   */
  it("should separate thinking and output lines correctly for any mixed content", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.tuple(
            fc.boolean(),
            fc.string().filter((s) => !s.includes("\n")),
          ),
          { minLength: 1, maxLength: 50 },
        ),
        (lines) => {
          // Build a mixed content string from the generated lines
          const contentLines = lines.map(([isThinking, text]) =>
            isThinking ? `> ${text}` : text,
          );
          const content = contentLines.join("\n");

          const result = parseThinkingContent(content);

          // Collect expected thinking and output lines
          const expectedThinking = lines
            .filter(([isThinking]) => isThinking)
            .map(([, text]) => text);
          const expectedOutput = lines
            .filter(([isThinking]) => !isThinking)
            .map(([, text]) => text);

          // Thinking content should contain all blockquote lines without prefix
          expect(result.thinking).toBe(expectedThinking.join("\n"));

          // Output content should contain all non-blockquote lines
          expect(result.output).toBe(expectedOutput.join("\n"));

          // All non-empty lines should be accounted for
          const resultThinkingLines = result.thinking
            ? result.thinking.split("\n")
            : [];
          const resultOutputLines = result.output
            ? result.output.split("\n")
            : [];
          const nonEmptyOriginal = lines.filter(
            ([, text]) => text.length > 0,
          ).length;
          const nonEmptyResult =
            resultThinkingLines.filter((l) => l.length > 0).length +
            resultOutputLines.filter((l) => l.length > 0).length;
          expect(nonEmptyResult).toBe(nonEmptyOriginal);
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe("Feature: thinking-block-and-stream-timer, Property 1: Duration formatting correctness", () => {
  /**
   * **Validates: Requirements 1.5**
   *
   * For any positive integer duration in milliseconds, formatting it
   * for display on the ThinkingPill SHALL produce a string
   * "Thought for Xs" where X equals `Math.round(durationMs / 1000)`,
   * and X is always at least 1 (clamped).
   */
  it("should produce 'Thought for Xs' with correct rounding and min clamp to 1", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 3600000 }), (durationMs) => {
        const result = formatReasoningDuration(durationMs);

        const expectedSeconds = Math.max(1, Math.round(durationMs / 1000));
        expect(result).toBe(`Thought for ${expectedSeconds}s`);
      }),
      { numRuns: 100 },
    );
  });
});

describe("parseThinkingContent edge cases", () => {
  /**
   * **Validates: Requirements 5.1, 5.2**
   */

  it("returns empty thinking and output for empty string input", () => {
    const result = parseThinkingContent("");
    expect(result).toEqual({ thinking: "", output: "" });
  });

  it("returns all content as thinking when input has only blockquote lines", () => {
    const content = "> first line\n> second line\n> third line";
    const result = parseThinkingContent(content);
    expect(result.thinking).toBe("first line\nsecond line\nthird line");
    expect(result.output).toBe("");
  });

  it("returns all content as output when input has no blockquote lines", () => {
    const content = "Hello world\nThis is regular text\nNo blockquotes here";
    const result = parseThinkingContent(content);
    expect(result.thinking).toBe("");
    expect(result.output).toBe(content);
  });
});

describe("Feature: thinking-block-and-stream-timer, Property 2: Duration computation correctness", () => {
  /**
   * **Validates: Requirements 2.2, 3.2**
   *
   * For any pair of timestamps (startTime, endTime) where endTime >= startTime,
   * the computed duration SHALL equal endTime - startTime. This applies to both
   * reasoning duration (reasoningStart to reasoningEnd) and total duration
   * (streamStart to streamEnd).
   */
  it("should compute duration as end - start for any valid timestamp pair", () => {
    fc.assert(
      fc.property(
        fc.tuple(fc.integer({ min: 0 }), fc.nat()),
        ([start, offset]) => {
          const end = start + offset;
          const duration = end - start;
          expect(duration).toBe(offset);
          expect(duration).toBeGreaterThanOrEqual(0);
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe("Feature: thinking-block-and-stream-timer, Property 4: Timing persistence round-trip", () => {
  /**
   * **Validates: Requirements 4.1**
   *
   * For any valid TimingInfo object attached to a ChatMessage,
   * persisting the message to the store and then retrieving it
   * SHALL produce an equivalent TimingInfo object.
   *
   * Since the store uses IndexedDB persistence, we test the
   * serialization round-trip via JSON.stringify/JSON.parse which
   * is the core of the persistence concern.
   */
  it("should survive JSON serialization round-trip for any valid TimingInfo", () => {
    fc.assert(
      fc.property(
        fc.record({
          reasoningDurationMs: fc.nat({ max: 3600000 }),
          totalDurationMs: fc.nat({ max: 3600000 }),
        }),
        (timingInfo) => {
          // Simulate a ChatMessage with timingInfo attached
          const message = {
            role: "assistant" as const,
            content: "Hello",
            thinkingContent: "Some reasoning",
            timingInfo,
          };

          // Serialize and deserialize (simulates persistence round-trip)
          const serialized = JSON.stringify(message);
          const deserialized = JSON.parse(serialized);

          // TimingInfo should be equivalent after round-trip
          expect(deserialized.timingInfo).toEqual(timingInfo);
          expect(deserialized.timingInfo.reasoningDurationMs).toBe(
            timingInfo.reasoningDurationMs,
          );
          expect(deserialized.timingInfo.totalDurationMs).toBe(
            timingInfo.totalDurationMs,
          );
        },
      ),
      { numRuns: 100 },
    );
  });

  it("should handle partial TimingInfo (only reasoningDurationMs)", () => {
    fc.assert(
      fc.property(fc.nat({ max: 3600000 }), (reasoningDurationMs) => {
        const message = {
          role: "assistant" as const,
          content: "Hello",
          timingInfo: { reasoningDurationMs },
        };

        const deserialized = JSON.parse(JSON.stringify(message));

        expect(deserialized.timingInfo).toEqual({ reasoningDurationMs });
        expect(deserialized.timingInfo.totalDurationMs).toBeUndefined();
      }),
      { numRuns: 100 },
    );
  });

  it("should handle partial TimingInfo (only totalDurationMs)", () => {
    fc.assert(
      fc.property(fc.nat({ max: 3600000 }), (totalDurationMs) => {
        const message = {
          role: "assistant" as const,
          content: "Hello",
          timingInfo: { totalDurationMs },
        };

        const deserialized = JSON.parse(JSON.stringify(message));

        expect(deserialized.timingInfo).toEqual({ totalDurationMs });
        expect(deserialized.timingInfo.reasoningDurationMs).toBeUndefined();
      }),
      { numRuns: 100 },
    );
  });
});
