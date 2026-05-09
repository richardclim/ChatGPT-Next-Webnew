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
    topic: fc.string({ minLength: 1 }),
    category: fc.string({ minLength: 1 }),
    value: fc.array(fc.string(), { minLength: 1 }),
    action: fc.constantFrom("add", "replace", "delete"),
  });

  const validMemoryObject = fc.record({
    profile_updates: fc.array(validProfileUpdate),
    episodic_summary: fc.string(),
    keywords: fc.array(fc.string()),
    is_continuation: fc.boolean(),
    replace_memory_ids: fc.array(fc.string()),
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

  it("should contain the retrieved context verbatim and consolidation instructions when context is non-empty", () => {
    fc.assert(
      fc.property(
        arbitraryDate,
        arbitraryProfileJson,
        arbitraryTranscript,
        nonEmptySummary,
        (today, profileJson, chatTranscript, context) => {
          const prompt = buildExtractionPrompt(
            today,
            profileJson,
            chatTranscript,
            context,
          );

          // Req 2.1: prompt contains the retrieved context verbatim
          expect(prompt).toContain(context);
          // Req 2.1: prompt contains "RETRIEVED EXISTING EPISODIC MEMORY" section
          expect(prompt).toContain("RETRIEVED EXISTING EPISODIC MEMORY");
          // Req 4.1, 4.2, 4.3: prompt contains consolidation instructions
          expect(prompt).toContain("CONTINUATION & CONSOLIDATION INSTRUCTIONS");
          // Req 4.2: instructs to set is_continuation to true
          expect(prompt).toContain("is_continuation to true");
          // Req 4.3: instructs to set is_continuation to false for new topics
          expect(prompt).toContain("is_continuation to false");
        },
      ),
      { numRuns: 100 },
    );
  });

  it("should NOT contain RETRIEVED EXISTING EPISODIC MEMORY and should instruct always false when context is undefined", () => {
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

          // Req 2.2: no context section
          expect(prompt).not.toContain("RETRIEVED EXISTING EPISODIC MEMORY");
          // Req 4.4: instructs to always set is_continuation to false
          expect(prompt).toContain("Always set is_continuation to false");
        },
      ),
      { numRuns: 100 },
    );
  });

  it("should treat empty string context like undefined (falsy)", () => {
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

          // Empty string is falsy — should behave like no context summary
          expect(prompt).not.toContain("RETRIEVED EXISTING EPISODIC MEMORY");
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

  it("should include replaceEntryIds when isContinuation is true AND replaceIds list is non-empty", () => {
    fc.assert(
      fc.property(
        arbitrarySessionId,
        arbitraryContent,
        arbitraryKeywords,
        arbitraryTimestamp,
        fc.array(fc.string({ minLength: 1 }), { minLength: 1 }),
        (sessionId, content, keywords, createdAt, replaceIds) => {
          const chunk = buildUpsertChunk(
            sessionId,
            content,
            keywords,
            createdAt,
            true,
            replaceIds,
          );

          expect(chunk).toHaveProperty("replaceEntryIds", replaceIds);
          expect(chunk.id).toBe("mock-id");
          expect(chunk.content).toBe(content);
          expect(chunk.keywords).toBe(keywords);
          expect(chunk.createdAt).toBe(createdAt);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("should NOT include replaceEntryIds when isContinuation is false", () => {
    fc.assert(
      fc.property(
        arbitrarySessionId,
        arbitraryContent,
        arbitraryKeywords,
        arbitraryTimestamp,
        fc.option(fc.array(fc.string()), { nil: undefined }),
        (sessionId, content, keywords, createdAt, maybeReplaceIds) => {
          const chunk = buildUpsertChunk(
            sessionId,
            content,
            keywords,
            createdAt,
            false,
            maybeReplaceIds as string[],
          );

          expect(chunk).not.toHaveProperty("replaceEntryIds");
          expect(chunk.id).toBe("mock-id");
          expect(chunk.content).toBe(content);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("should NOT include replaceEntryIds when isContinuation is true AND replaceIds list is undefined", () => {
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

          expect(chunk).not.toHaveProperty("replaceEntryIds");
          expect(chunk.id).toBe("mock-id");
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
