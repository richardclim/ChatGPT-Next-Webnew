import { jest, describe, it, expect } from '@jest/globals';
import { ServiceProvider } from "../constant";

// Mock idb-keyval to avoid indexedDB issues when store files are loaded
jest.unstable_mockModule('idb-keyval', () => ({
  createStore: jest.fn(),
  get: jest.fn(),
  set: jest.fn(),
  del: jest.fn(),
  update: jest.fn(),
  clear: jest.fn(),
}));

// Dynamic imports to ensure mocks are applied first
const { fillTemplateWith } = await import("./chat-utils");
const { DEFAULT_MODELS } = await import("../constant");

// Define local interface to avoid importing from client/api which triggers store loading
interface LLMModel {
  name: string;
  available: boolean;
  provider: {
    id: string;
    providerName: string;
    providerType: string;
    sorted: number;
  };
  sorted: number;
}

describe("fillTemplateWith", () => {
  it("should correctly identify OpenAI provider for default models", () => {
    // @ts-ignore
    const modelConfig = {
      model: "gpt-4o",
      providerName: ServiceProvider.OpenAI,
      template: "{{ServiceProvider}}",
    };

    const allModels: LLMModel[] = DEFAULT_MODELS as unknown as LLMModel[];

    // @ts-ignore
    const result = fillTemplateWith("", modelConfig, allModels, "en");
    expect(result).toContain("OpenAI");
  });

  it("should correctly identify provider for custom models when present in allModels", () => {
      // @ts-ignore
      const modelConfig = {
        model: "custom-model",
        providerName: "SomeConfiguredProvider",
        template: "{{ServiceProvider}}",
      };

      const customModel: LLMModel = {
          name: "custom-model",
          available: true,
          provider: {
              id: "custom",
              providerName: "MyCustomProvider",
              providerType: "custom",
              sorted: 100
          },
          sorted: 100
      };

      const allModels: LLMModel[] = [...(DEFAULT_MODELS as unknown as LLMModel[]), customModel];

      // @ts-ignore
      const result = fillTemplateWith("", modelConfig, allModels, "en");
      expect(result).toContain("MyCustomProvider");
  });

  it("should fallback to modelConfig.providerName if model not found in allModels", () => {
      // @ts-ignore
      const modelConfig = {
        model: "unknown-model",
        providerName: "FallbackProvider",
        template: "{{ServiceProvider}}",
      };

      const allModels: LLMModel[] = DEFAULT_MODELS as unknown as LLMModel[];

      // @ts-ignore
      const result = fillTemplateWith("", modelConfig, allModels, "en");
      expect(result).toContain("FallbackProvider");
  });
});
