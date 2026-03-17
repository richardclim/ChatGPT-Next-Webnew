// Mock the store module to avoid deep dependency chain that pulls in ESM modules
// (nanoid, lodash-es) which Jest cannot transform
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
  createPersistStore: jest.fn((_default: any, _methods: any, _opts: any) => {
    return () => ({});
  }),
}));
jest.mock("@/app/store/chat", () => ({
  ChatMessage: {},
  createMessage: jest.fn(),
}));
jest.mock("@/app/store/config", () => ({
  ModelConfig: {},
  ModelType: {},
  useAppConfig: { getState: () => ({ modelConfig: {} }) },
}));

import * as fc from "fast-check";
import { memorySchema } from "../memory";

/**
 * Feature: episodic-memory-continuity, Property 1: Memory schema accepts and requires is_continuation
 * Validates: Requirements 3.1
 */
describe("Property 1: Memory schema accepts and requires is_continuation", () => {
  const validProfileUpdate = fc.record({
    category: fc.string({ minLength: 1 }),
    attribute: fc.string({ minLength: 1 }),
    value: fc.array(fc.string(), { minLength: 1 }),
  });

  const validMemoryObject = fc.record({
    profile_updates: fc.array(validProfileUpdate),
    episodic_summary: fc.string(),
    keywords: fc.array(fc.string()),
    is_continuation: fc.boolean(),
  });

  it("should parse successfully when is_continuation is a boolean", () => {
    fc.assert(
      fc.property(validMemoryObject, (obj) => {
        const result = memorySchema.safeParse(obj);
        expect(result.success).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it("should reject objects missing is_continuation", () => {
    const objectWithoutContinuation = fc.record({
      profile_updates: fc.array(validProfileUpdate),
      episodic_summary: fc.string(),
      keywords: fc.array(fc.string()),
    });

    fc.assert(
      fc.property(objectWithoutContinuation, (obj) => {
        const result = memorySchema.safeParse(obj);
        expect(result.success).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  it("should reject objects with non-boolean is_continuation", () => {
    const nonBooleanValue = fc.oneof(
      fc.string(),
      fc.integer(),
      fc.constant(null),
      fc.array(fc.boolean()),
    );

    const objectWithBadContinuation = fc.record({
      profile_updates: fc.array(validProfileUpdate),
      episodic_summary: fc.string(),
      keywords: fc.array(fc.string()),
      is_continuation: nonBooleanValue,
    });

    fc.assert(
      fc.property(objectWithBadContinuation, (obj) => {
        const result = memorySchema.safeParse(obj);
        expect(result.success).toBe(false);
      }),
      { numRuns: 100 },
    );
  });
});

import { buildExtractionPrompt } from "../memory";

/**
 * Feature: episodic-memory-continuity, Property 2: Prompt includes previous summary and continuation instructions when provided
 * Validates: Requirements 2.1, 2.2, 4.1, 4.2, 4.3, 4.4
 */
describe("Property 2: Prompt includes previous summary and continuation instructions when provided", () => {
  const arbitraryDate = fc.string({ minLength: 1 });
  const arbitraryProfileJson = fc.string();
  const arbitraryTranscript = fc.string({ minLength: 1 });
  const nonEmptySummary = fc.string({ minLength: 1 });

  it("should contain the previous summary verbatim and continuation instructions when previousSummary is non-empty", () => {
    fc.assert(
      fc.property(
        arbitraryDate,
        arbitraryProfileJson,
        arbitraryTranscript,
        nonEmptySummary,
        (today, profileJson, chatTranscript, previousSummary) => {
          const prompt = buildExtractionPrompt(
            today,
            profileJson,
            chatTranscript,
            previousSummary,
          );

          // Req 2.1: prompt contains the previous summary verbatim
          expect(prompt).toContain(previousSummary);
          // Req 2.1: prompt contains "PREVIOUS SUMMARY" section
          expect(prompt).toContain("PREVIOUS SUMMARY");
          // Req 4.1, 4.2, 4.3: prompt contains continuation instructions
          expect(prompt).toContain("CONTINUATION INSTRUCTIONS");
          // Req 4.2: instructs to set is_continuation to true
          expect(prompt).toContain("is_continuation to true");
          // Req 4.3: instructs to set is_continuation to false for new topics
          expect(prompt).toContain("is_continuation to false");
        },
      ),
      { numRuns: 100 },
    );
  });

  it("should NOT contain PREVIOUS SUMMARY and should instruct always false when previousSummary is undefined", () => {
    fc.assert(
      fc.property(
        arbitraryDate,
        arbitraryProfileJson,
        arbitraryTranscript,
        (today, profileJson, chatTranscript) => {
          const prompt = buildExtractionPrompt(
            today,
            profileJson,
            chatTranscript,
            undefined,
          );

          // Req 2.2: no PREVIOUS SUMMARY section
          expect(prompt).not.toContain("PREVIOUS SUMMARY");
          // Req 4.4: instructs to always set is_continuation to false
          expect(prompt).toContain("Always set is_continuation to false");
        },
      ),
      { numRuns: 100 },
    );
  });

  it("should treat empty string previousSummary like undefined (falsy)", () => {
    fc.assert(
      fc.property(
        arbitraryDate,
        arbitraryProfileJson,
        arbitraryTranscript,
        (today, profileJson, chatTranscript) => {
          const prompt = buildExtractionPrompt(
            today,
            profileJson,
            chatTranscript,
            "",
          );

          // Empty string is falsy — should behave like no previous summary
          expect(prompt).not.toContain("PREVIOUS SUMMARY");
          expect(prompt).toContain("Always set is_continuation to false");
        },
      ),
      { numRuns: 100 },
    );
  });
});

import { buildUpsertChunk } from "../memory";

/**
 * Feature: episodic-memory-continuity, Property 3: Client-side routing includes replaceEntryId if and only if continuation with existing entry
 * Validates: Requirements 5.1, 5.2, 5.3
 */
describe("Property 3: Client-side routing includes replaceEntryId if and only if continuation with existing entry", () => {
  const arbitrarySessionId = fc.string({ minLength: 1 });
  const arbitraryContent = fc.string({ minLength: 1 });
  const arbitraryKeywords = fc.array(fc.string());
  const arbitraryTimestamp = fc.nat();
  const nonEmptyEntryId = fc.string({ minLength: 1 });

  it("should include replaceEntryId when isContinuation is true AND lastEpisodicEntryId is a non-empty string", () => {
    fc.assert(
      fc.property(
        arbitrarySessionId,
        arbitraryContent,
        arbitraryKeywords,
        arbitraryTimestamp,
        nonEmptyEntryId,
        (sessionId, content, keywords, createdAt, entryId) => {
          const chunk = buildUpsertChunk(
            sessionId,
            content,
            keywords,
            createdAt,
            true,
            entryId,
          );

          expect(chunk).toHaveProperty("replaceEntryId", entryId);
          expect(chunk.id).toBe(sessionId);
          expect(chunk.content).toBe(content);
          expect(chunk.keywords).toBe(keywords);
          expect(chunk.createdAt).toBe(createdAt);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("should NOT include replaceEntryId when isContinuation is false", () => {
    fc.assert(
      fc.property(
        arbitrarySessionId,
        arbitraryContent,
        arbitraryKeywords,
        arbitraryTimestamp,
        fc.option(fc.string({ minLength: 1 }), { nil: undefined }),
        (sessionId, content, keywords, createdAt, maybeEntryId) => {
          const chunk = buildUpsertChunk(
            sessionId,
            content,
            keywords,
            createdAt,
            false,
            maybeEntryId,
          );

          expect(chunk).not.toHaveProperty("replaceEntryId");
          expect(chunk.id).toBe(sessionId);
          expect(chunk.content).toBe(content);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("should NOT include replaceEntryId when isContinuation is true AND lastEpisodicEntryId is undefined", () => {
    fc.assert(
      fc.property(
        arbitrarySessionId,
        arbitraryContent,
        arbitraryKeywords,
        arbitraryTimestamp,
        (sessionId, content, keywords, createdAt) => {
          const chunk = buildUpsertChunk(
            sessionId,
            content,
            keywords,
            createdAt,
            true,
            undefined,
          );

          expect(chunk).not.toHaveProperty("replaceEntryId");
          expect(chunk.id).toBe(sessionId);
          expect(chunk.content).toBe(content);
        },
      ),
      { numRuns: 100 },
    );
  });
});

import type { ExtractionResult } from "../memory";

/**
 * Feature: episodic-memory-continuity, Property 6: Extraction result contains full metadata on success with episodic summary
 * Validates: Requirements 1.5, 7.1, 7.2
 */
describe("Property 6: Extraction result contains full metadata on success with episodic summary", () => {
  const nonEmptyString = fc.string({ minLength: 1 });

  const fullExtractionResult: fc.Arbitrary<ExtractionResult> = fc.record({
    lastMessageId: nonEmptyString,
    episodicSummary: nonEmptyString,
    entryId: nonEmptyString,
  });

  const partialExtractionResult: fc.Arbitrary<ExtractionResult> = fc.record({
    lastMessageId: nonEmptyString,
  });

  it("should have lastMessageId, episodicSummary, and entryId all defined when extraction produces an episodic summary", () => {
    fc.assert(
      fc.property(fullExtractionResult, (result) => {
        // Req 7.1: result contains lastMessageId
        expect(result.lastMessageId).toBeDefined();
        expect(typeof result.lastMessageId).toBe("string");
        expect(result.lastMessageId.length).toBeGreaterThan(0);

        // Req 1.5, 7.1: result contains episodicSummary
        expect(result.episodicSummary).toBeDefined();
        expect(typeof result.episodicSummary).toBe("string");
        expect(result.episodicSummary!.length).toBeGreaterThan(0);

        // Req 7.1: result contains entryId
        expect(result.entryId).toBeDefined();
        expect(typeof result.entryId).toBe("string");
        expect(result.entryId!.length).toBeGreaterThan(0);
      }),
      { numRuns: 100 },
    );
  });

  it("should have only lastMessageId when extraction succeeds without an episodic summary", () => {
    fc.assert(
      fc.property(partialExtractionResult, (result) => {
        // Req 7.2: result contains lastMessageId
        expect(result.lastMessageId).toBeDefined();
        expect(typeof result.lastMessageId).toBe("string");
        expect(result.lastMessageId.length).toBeGreaterThan(0);

        // Req 7.2: episodicSummary and entryId should be absent
        expect(result.episodicSummary).toBeUndefined();
        expect(result.entryId).toBeUndefined();
      }),
      { numRuns: 100 },
    );
  });
});
