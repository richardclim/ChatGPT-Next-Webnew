import { jest } from "@jest/globals";

// Mock store utility early to bypass persistence logic entirely
jest.mock("@/app/utils/store", () => ({
  createPersistStore: jest.fn((initialState: any, creator: any) => {
    const set = jest.fn((updater: any) => {
      if (typeof updater === 'function') {
        const nextState = { ...initialState };
        updater(nextState);
        Object.assign(initialState, nextState);
      } else {
        Object.assign(initialState, updater);
      }
    });
    const get = () => ({ ...initialState, ...methods });
    const methods = creator(set, get);
    return () => ({ ...initialState, ...methods });
  })
}));

import * as apiModule from "@/app/client/api";
import { useMemoryStore } from "../memory";

// Mock other stores using absolute paths
jest.mock("@/app/store/chat", () => ({
  useChatStore: {
    getState: () => ({
      currentSession: () => ({
        mask: { modelConfig: {} }
      })
    })
  },
  createMessage: (msg: any) => msg
}));

jest.mock("@/app/store/config", () => ({
  useAppConfig: {
    getState: () => ({
      modelConfig: {}
    })
  }
}));

jest.mock("@/app/store/access", () => ({
  useAccessStore: {
    getState: () => ({
      enabledAccessControl: () => false
    })
  }
}));

// Mock global fetch
global.fetch = jest.fn() as any;

describe("Profile Hybrid Vector Architecture", () => {
  let store: any;
  let mockChat: any;
  let getClientApiSpy: any;

  beforeEach(() => {
    jest.clearAllMocks();
    
    mockChat = jest.fn();
    getClientApiSpy = jest.spyOn(apiModule, "getClientApi").mockReturnValue({
      llm: { chat: mockChat }
    } as any);

    store = useMemoryStore.getState();
    store.content = {};
  });

  afterEach(() => {
    getClientApiSpy.mockRestore();
  });

  describe("triggerProfileMigration", () => {
    it("should correctly identify categories and upsert them", async () => {
      store.content = {
        test_topic: {
          test_cat: ["val1"]
        }
      };

      (global.fetch as any).mockResolvedValue({ ok: true });

      await store.triggerProfileMigration();

      expect(global.fetch).toHaveBeenCalledWith(
        "/api/vector/profile/upsert",
        expect.objectContaining({
          method: "POST",
          body: expect.stringContaining("profile_test_topic_test_cat"),
        })
      );
    });
  });

  describe("processExtraction (Sync Hook)", () => {
    it("should trigger sync fetch when profile updates are detected", async () => {
      const messages = [{ role: "user", content: "test", id: "1" }];
      
      mockChat.mockImplementation(({ onFinish }: any) => {
        onFinish(JSON.stringify({
          profile_updates: [
            { category: "coding", attribute: "languages", value: ["Go"], action: "add" }
          ],
          episodic_summary: "summary",
          keywords: ["Go"]
        }), { status: 200 });
      });

      (global.fetch as any).mockResolvedValue({ 
        ok: true, 
        json: () => Promise.resolve({ success: true }) 
      });

      await store.processExtraction(messages as any, "session-1");

      expect(store.content.coding.languages).toContain("Go");
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/vector/profile/upsert",
        expect.objectContaining({ method: "POST" })
      );
    });
  });

  describe("findRelevant", () => {
    it("should decompose query and search profile vector", async () => {
      store.content = { coding: { languages: ["Go"] } };

      mockChat.mockImplementationOnce(({ onFinish }: any) => {
        onFinish(JSON.stringify({ queries: ["Go programming"] }));
      });

      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          results: [{ id: "profile_coding_languages" }]
        })
      });

      mockChat.mockImplementationOnce(({ onFinish }: any) => {
        onFinish("User likes Go.", { status: 200 });
      });

      const result = await store.findRelevant("Go?");

      expect(result).toBe("User likes Go.");
    });

    it("should handle empty vector search results gracefully", async () => {
      store.content = { coding: { languages: ["Go"] } };

      // 1. Mock Decomposition
      mockChat.mockImplementationOnce(({ onFinish }: any) => {
        onFinish(JSON.stringify({ queries: ["Random query"] }));
      });

      // 2. Mock Vector Search returning nothing
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ results: [] })
      });

      const result = await store.findRelevant("Something unknown?");

      expect(result).toBe("");
      // Final rerank LLM should NOT have been called
      expect(mockChat).toHaveBeenCalledTimes(1);
    });
  });

  describe("Deletion Flow Sync", () => {
    it("should trigger a DELETE command to vector store when a category is emptied", async () => {
      const messages = [{ role: "user", content: "Forget about my location", id: "1" }];
      
      // Mock LLM response for deletion
      mockChat.mockImplementation(({ onFinish }: any) => {
        onFinish(JSON.stringify({
          profile_updates: [
            { category: "personal", attribute: "location", value: [], action: "delete" }
          ],
          episodic_summary: "Deleted location",
          keywords: []
        }), { status: 200 });
      });

      (global.fetch as any).mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });

      // Pre-set some value
      store.content = { personal: { location: ["London"] } };

      await store.processExtraction(messages as any, "session-1");

      // Verify sync fetch called with Deletes array
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/vector/profile/upsert",
        expect.objectContaining({
          method: "POST",
          body: expect.stringContaining('"deletes":["profile_personal_location"]')
        })
      );
    });
  });

  describe("Manual UI Sync (updateContent)", () => {
    it("should trigger upserts and deletes when UI manually updates the JSON", async () => {
      // 1. Initial State
      store.content = { 
        health: { diet: ["vegan"] },
        personal: { city: ["NY"] } 
      };

      (global.fetch as any).mockResolvedValue({ ok: true });

      // 2. Perform Manual Update: Update 'diet', Add 'coding', Delete 'city'
      const nextProfile = {
        health: { diet: ["vegan", "keto"] }, // Updated
        coding: { languages: ["JS"] },      // New
        personal: {}                        // 'city' removed
      };

      store.updateContent(nextProfile);

      // Verify the fetch call
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/vector/profile/upsert",
        expect.objectContaining({
          method: "POST",
          body: expect.stringMatching(/profile_health_diet/)
        })
      );

      const body = JSON.parse((global.fetch as any).mock.calls[0][1].body);
      
      // Should have 2 upserts (health_diet, coding_languages)
      expect(body.upserts).toHaveLength(2);
      expect(body.upserts.map((u: any) => u.id)).toContain("profile_health_diet");
      expect(body.upserts.map((u: any) => u.id)).toContain("profile_coding_languages");
      
      // Should have 1 delete (personal_city)
      expect(body.deletes).toContain("profile_personal_city");
    });
  });
});
