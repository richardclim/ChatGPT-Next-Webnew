// Mock heavy dependencies that chat.ts imports at module level
jest.mock("@/app/store/memory", () => ({
  useMemoryStore: { getState: () => ({}) },
}));
jest.mock("@/app/store/config", () => ({
  ModelConfig: {},
  ModelType: {},
  useAppConfig: { getState: () => ({ modelConfig: {} }) },
}));
jest.mock("@/app/store/access", () => ({
  useAccessStore: { getState: () => ({}) },
}));
jest.mock("@/app/store/mask", () => ({
  createEmptyMask: () => ({}),
  Mask: {},
}));
jest.mock("@/app/store", () => ({
  useAccessStore: { getState: () => ({}) },
}));
jest.mock("@/app/components/ui-lib", () => ({
  showToast: jest.fn(),
}));
jest.mock("nanoid", () => ({
  nanoid: () => "mock-id",
}));
jest.mock("lodash-es", () => ({}));
jest.mock("@/app/client/api", () => ({
  getClientApi: jest.fn(),
}));
jest.mock("@/app/utils/store", () => ({
  createPersistStore: jest.fn(() => () => ({})),
}));
jest.mock("@/app/utils/indexedDB-storage", () => ({
  indexedDBStorage: {},
  readPersistEnvelope: jest.fn(),
  PersistEnvelope: {},
  attachStoragePingListener: jest.fn(),
}));
jest.mock("@/app/mcp/actions", () => ({
  executeMcpAction: jest.fn(),
  getAllTools: jest.fn(),
  isMcpEnabled: jest.fn(),
}));
jest.mock("@/app/mcp/utils", () => ({
  extractMcpJson: jest.fn(),
  isMcpJson: jest.fn(),
}));

import * as fc from "fast-check";
import { applyExtractionResult } from "../chat";
import type { ExtractionResult } from "../memory";

/**
 * Feature: episodic-memory-continuity, Property 7: Session fields are updated atomically from extraction metadata
 * Validates: Requirements 1.6, 1.7, 7.4
 */
describe("Property 7: Session fields are updated atomically from extraction metadata", () => {
  const nonEmptyString = fc.string({ minLength: 1 });

  const makeSession = () => ({
    lastArchivedContextId: undefined as string | undefined,
    lastExtractionTime: undefined as number | undefined,
    lastEpisodicSummary: undefined as string | undefined,
    lastEpisodicEntryId: undefined as string | undefined,
  });

  it("should update all session fields when result has all fields", () => {
    const fullResult = fc.record({
      lastMessageId: nonEmptyString,
      episodicSummary: nonEmptyString,
      entryId: nonEmptyString,
    });

    fc.assert(
      fc.property(fullResult, (result: ExtractionResult) => {
        const session = makeSession();
        const before = Date.now();
        applyExtractionResult(session, result);
        const after = Date.now();

        // Req 7.4: lastArchivedContextId updated from result
        expect(session.lastArchivedContextId).toBe(result.lastMessageId);
        // Req 1.6: lastEpisodicSummary updated from result
        expect(session.lastEpisodicSummary).toBe(result.episodicSummary);
        // Req 1.7: lastEpisodicEntryId updated from result
        expect(session.lastEpisodicEntryId).toBe(result.entryId);
        // lastExtractionTime set to current time
        expect(session.lastExtractionTime).toBeGreaterThanOrEqual(before);
        expect(session.lastExtractionTime).toBeLessThanOrEqual(after);
      }),
      { numRuns: 100 },
    );
  });

  it("should only update lastArchivedContextId when result has no episodic fields", () => {
    const minimalResult = fc.record({
      lastMessageId: nonEmptyString,
    });

    // Pre-populate session with existing values to verify they are preserved
    const existingSummary = fc.string({ minLength: 1 });
    const existingEntryId = fc.string({ minLength: 1 });

    fc.assert(
      fc.property(
        minimalResult,
        existingSummary,
        existingEntryId,
        (
          result: ExtractionResult,
          prevSummary: string,
          prevEntryId: string,
        ) => {
          const session = makeSession();
          session.lastEpisodicSummary = prevSummary;
          session.lastEpisodicEntryId = prevEntryId;

          applyExtractionResult(session, result);

          // lastArchivedContextId updated
          expect(session.lastArchivedContextId).toBe(result.lastMessageId);
          // lastExtractionTime set
          expect(session.lastExtractionTime).toBeDefined();
          // Existing episodic fields preserved (not overwritten)
          expect(session.lastEpisodicSummary).toBe(prevSummary);
          expect(session.lastEpisodicEntryId).toBe(prevEntryId);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("should update lastEpisodicSummary but preserve lastEpisodicEntryId when result has summary but no entryId", () => {
    const resultWithSummaryOnly = fc.record({
      lastMessageId: nonEmptyString,
      episodicSummary: nonEmptyString,
    });

    const existingEntryId = fc.string({ minLength: 1 });

    fc.assert(
      fc.property(
        resultWithSummaryOnly,
        existingEntryId,
        (result: ExtractionResult, prevEntryId: string) => {
          const session = makeSession();
          session.lastEpisodicEntryId = prevEntryId;

          applyExtractionResult(session, result);

          // lastArchivedContextId updated
          expect(session.lastArchivedContextId).toBe(result.lastMessageId);
          // Req 1.6: lastEpisodicSummary updated
          expect(session.lastEpisodicSummary).toBe(result.episodicSummary);
          // lastEpisodicEntryId preserved (entryId was undefined)
          expect(session.lastEpisodicEntryId).toBe(prevEntryId);
        },
      ),
      { numRuns: 100 },
    );
  });
});
