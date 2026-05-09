import { useWorkspaceStore } from "../workspace";
import { useChatStore } from "../chat";
import { useAppConfig } from "../config";
import { getClientApi } from "../../client/api";

// 1. Mock createPersistStore to bypass persistence
jest.mock("../../utils/store", () => ({
  createPersistStore: jest.fn((initialState: any, creator: any) => {
    let state = { ...initialState };
    const set = (updater: any) => {
      if (typeof updater === "function") {
        const patch = updater(state);
        state = { ...state, ...patch };
      } else {
        state = { ...state, ...updater };
      }
    };
    const get = () => ({ ...state, ...methods });
    const methods = creator(set, get);
    return () => ({ ...state, ...methods });
  }),
}));

// 2. Mock external dependencies
jest.mock("../chat", () => ({
  useChatStore: {
    getState: jest.fn(),
  },
}));

jest.mock("../config", () => ({
  useAppConfig: {
    getState: jest.fn(),
  },
}));

jest.mock("../../client/api", () => ({
  getClientApi: jest.fn(),
  ServiceProvider: {
    OpenAI: "OpenAI",
  },
}));

jest.mock("../../components/ui-lib", () => ({
  showToast: jest.fn(),
}));

jest.mock("nanoid", () => ({
  nanoid: () => "mock-id",
}));

describe("Workspace Store Parsing Logic", () => {
  let workspaceStore: any;
  let mockChat: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    workspaceStore = useWorkspaceStore();
    mockChat = jest.fn();

    // Setup mocks
    (getClientApi as jest.Mock).mockReturnValue({
      llm: { chat: mockChat },
    });

    (useChatStore.getState as jest.Mock).mockReturnValue({
      sessions: [
        {
          id: "session-1",
          messages: [{ id: "msg-1", role: "user", content: "hello" }],
          lastWorkspaceSyncMessageId: null,
        },
      ],
      updateTargetSession: jest.fn(),
    });

    (useAppConfig.getState as jest.Mock).mockReturnValue({
      modelConfig: {
        workspaceProviderName: "OpenAI",
        workspaceModel: "gpt-4",
      },
    });
  });

  it("should prepend top-level header if the LLM response starts with a sub-header (the bug fix)", async () => {
    const wsId = workspaceStore.createWorkspace("My Workspace", "# My Workspace\n\n## Workflow\nOld content\n");
    
    // Simulate LLM response starting with a sub-header
    mockChat.mockImplementation(({ onFinish }) => {
      onFinish('<update header="Workflow">\n### Subheader\nNew content\n</update>');
    });

    await workspaceStore.syncWorkspaceContext(wsId, "session-1");

    const updatedWorkspace = useWorkspaceStore().workspaces[wsId];
    // It should have both the top-level header AND the subheader
    expect(updatedWorkspace.content).toContain("## Workflow");
    expect(updatedWorkspace.content).toContain("### Subheader");
    expect(updatedWorkspace.content).toContain("New content");
  });

  it("should NOT double-prepend if the LLM response already includes the exact header", async () => {
    const wsId = workspaceStore.createWorkspace("My Workspace", "# My Workspace\n\n## Workflow\nOld content\n");
    
    // Simulate LLM response including the header
    mockChat.mockImplementation(({ onFinish }) => {
      onFinish('<update header="Workflow">\n## Workflow\nNew content with header\n</update>');
    });

    await workspaceStore.syncWorkspaceContext(wsId, "session-1");

    const updatedWorkspace = useWorkspaceStore().workspaces[wsId];
    // Check that we don't have ## Workflow twice in the final block
    const count = (updatedWorkspace.content.match(/## Workflow/g) || []).length;
    expect(count).toBe(1);
    expect(updatedWorkspace.content).toContain("New content with header");
  });

  it("should prepend header if the LLM response has no header at all", async () => {
    const wsId = workspaceStore.createWorkspace("My Workspace", "# My Workspace\n\n## Workflow\nOld content\n");
    
    mockChat.mockImplementation(({ onFinish }) => {
      onFinish('<update header="Workflow">\nPure content without hashtags\n</update>');
    });

    await workspaceStore.syncWorkspaceContext(wsId, "session-1");

    const updatedWorkspace = useWorkspaceStore().workspaces[wsId];
    expect(updatedWorkspace.content).toContain("## Workflow\n\nPure content without hashtags");
  });

  it("should handle deleting sections correctly", async () => {
    const wsId = workspaceStore.createWorkspace("My Workspace", "# My Workspace\n\n## Workflow\nContent\n\n## Tech Stack\nTech info\n");
    
    mockChat.mockImplementation(({ onFinish }) => {
      onFinish('<delete header="Workflow"></delete>');
    });

    await workspaceStore.syncWorkspaceContext(wsId, "session-1");

    const updatedWorkspace = useWorkspaceStore().workspaces[wsId];
    expect(updatedWorkspace.content).not.toContain("## Workflow");
    expect(updatedWorkspace.content).toContain("## Tech Stack");
  });
});
