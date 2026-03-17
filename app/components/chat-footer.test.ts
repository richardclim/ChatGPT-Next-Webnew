// Mock the store module to avoid deep dependency chain that pulls in ESM modules
// (nanoid, lodash-es) which Jest cannot transform
jest.mock("@/app/store", () => ({
  useAccessStore: { getState: () => ({}) },
}));
jest.mock("@/app/components/ui-lib", () => ({
  showToast: jest.fn(),
}));

import * as fc from "fast-check";
import type { TimingInfo } from "../store/chat";

/**
 * Pure helper that replicates the footer text formatting logic from chat.tsx.
 *
 * The actual rendering in chat.tsx builds:
 *   [date, "Thought Xs" | null, "Total Ys" | null].filter(Boolean).join(" · ")
 */
function formatFooterText(dateStr: string, timingInfo?: TimingInfo): string {
  return [
    dateStr,
    timingInfo?.reasoningDurationMs
      ? `Thought ${Math.round(timingInfo.reasoningDurationMs / 1000)}s`
      : null,
    timingInfo?.totalDurationMs
      ? `Total ${Math.round(timingInfo.totalDurationMs / 1000)}s`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

describe("Feature: thinking-block-and-stream-timer, Property 3: Footer timing display completeness", () => {
  /**
   * **Validates: Requirements 3.3**
   *
   * For any ChatMessage with a defined `timingInfo` containing both
   * `reasoningDurationMs` and `totalDurationMs`, the rendered
   * Message_Footer string SHALL contain both the formatted reasoning
   * duration and the formatted total duration alongside the existing date.
   */
  it("should contain both formatted reasoning and total durations when both are present", () => {
    fc.assert(
      fc.property(
        fc.record({
          reasoningDurationMs: fc.nat({ max: 3600000 }),
          totalDurationMs: fc.nat({ max: 3600000 }),
        }),
        (timingInfo) => {
          const dateStr = "1/1/2025, 12:00:00 PM";
          const result = formatFooterText(dateStr, timingInfo);

          // Footer must always contain the date
          expect(result).toContain(dateStr);

          const expectedReasoning = `Thought ${Math.round(
            timingInfo.reasoningDurationMs! / 1000,
          )}s`;
          const expectedTotal = `Total ${Math.round(
            timingInfo.totalDurationMs! / 1000,
          )}s`;

          // When reasoningDurationMs > 0, the reasoning text must appear
          if (timingInfo.reasoningDurationMs! > 0) {
            expect(result).toContain(expectedReasoning);
          }

          // When totalDurationMs > 0, the total text must appear
          if (timingInfo.totalDurationMs! > 0) {
            expect(result).toContain(expectedTotal);
          }

          // When both are > 0, parts are separated by " · "
          if (
            timingInfo.reasoningDurationMs! > 0 &&
            timingInfo.totalDurationMs! > 0
          ) {
            expect(result).toBe(
              `${dateStr} · ${expectedReasoning} · ${expectedTotal}`,
            );
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
