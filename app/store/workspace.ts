import { createPersistStore } from "../utils/store";
import { ServiceProvider } from "../constant";
import { ChatMessage, useChatStore } from "./chat";
import { getClientApi } from "../client/api";
import { useAppConfig } from "./config";
import { nanoid } from "nanoid";
import { showToast } from "../components/ui-lib";

export interface WorkspaceRevision {
  timestamp: number;
  content: string;
}

export interface Workspace {
  id: string;
  title: string;
  content: string;
  isSyncing: boolean;
  linkedSessions: string[];
  revisions: WorkspaceRevision[];
  lastSyncedTimestamp: number;
  lastSyncError?: string;
}

const DEFAULT_WORKSPACE_STATE = {
  workspaces: {} as Record<string, Workspace>,
};

export const useWorkspaceStore = createPersistStore(
  DEFAULT_WORKSPACE_STATE,
  (set, _get) => {
    function get() {
      return {
        ..._get(),
        ...methods,
      };
    }

    const methods = {
      createWorkspace(title: string, initialContent?: string) {
        const id = nanoid();
        const newWorkspace: Workspace = {
          id,
          title,
          content:
            initialContent ||
            `# ${title}\n\n## Unanswered Questions\n- What are the main objectives of this research?\n`,
          isSyncing: false,
          linkedSessions: [],
          revisions: [],
          lastSyncedTimestamp: Date.now(),
        };
        set((state) => ({
          workspaces: {
            ...state.workspaces,
            [id]: newWorkspace,
          },
        }));
        return id;
      },

      updateWorkspaceTitle(id: string, title: string) {
        set((state) => {
          const workspace = state.workspaces[id];
          if (!workspace) return state;
          return {
            workspaces: {
              ...state.workspaces,
              [id]: { ...workspace, title },
            },
          };
        });
      },

      updateWorkspaceContent(
        id: string,
        content: string,
        createRevision: boolean = false,
      ) {
        set((state) => {
          const workspace = state.workspaces[id];
          if (!workspace) return state;

          const newRevisions =
            createRevision && workspace.content !== content
              ? [
                  ...workspace.revisions,
                  { timestamp: Date.now(), content: workspace.content },
                ]
              : workspace.revisions;

          return {
            workspaces: {
              ...state.workspaces,
              [id]: {
                ...workspace,
                revisions: newRevisions,
                content,
                lastSyncedTimestamp: Date.now(),
              },
            },
          };
        });
      },

      setSyncing(id: string, isSyncing: boolean) {
        set((state) => {
          const workspace = state.workspaces[id];
          if (!workspace) return state;
          return {
            workspaces: {
              ...state.workspaces,
              [id]: { ...workspace, isSyncing },
            },
          };
        });
      },

      setSyncError(id: string, error?: string) {
        set((state) => {
          const workspace = state.workspaces[id];
          if (!workspace) return state;
          return {
            workspaces: {
              ...state.workspaces,
              [id]: { ...workspace, lastSyncError: error },
            },
          };
        });
      },

      deleteWorkspace(id: string) {
        set((state) => {
          const newWorkspaces = { ...state.workspaces };
          delete newWorkspaces[id];
          return { workspaces: newWorkspaces };
        });
      },

      async syncWorkspaceContext(workspaceId: string, sessionId: string) {
        const workspace = get().workspaces[workspaceId];
        if (!workspace) return;
        if (workspace.isSyncing) return;

        const chatStore = useChatStore.getState();
        const session = chatStore.sessions.find((s) => s.id === sessionId);
        if (!session || session.messages.length === 0) {
          showToast("No chat history to sync.");
          return;
        }

        const syncIndex = session.lastWorkspaceSyncMessageId
          ? session.messages.findIndex(
              (m) => m.id === session.lastWorkspaceSyncMessageId,
            )
          : -1;

        let unsyncedMessages = session.messages;
        if (syncIndex !== -1) {
          unsyncedMessages = session.messages.slice(syncIndex + 1);
        }

        if (unsyncedMessages.length === 0) {
          showToast("Workspace is already up to date.");
          return;
        }

        const latestMessageId =
          unsyncedMessages[unsyncedMessages.length - 1].id;

        get().setSyncing(workspaceId, true);

        try {
          const configStore = useAppConfig.getState();
          const globalConfig = configStore.modelConfig;

          // Add to linked sessions if not present
          set((state) => {
            const ws = state.workspaces[workspaceId];
            if (ws && !ws.linkedSessions.includes(sessionId)) {
              return {
                workspaces: {
                  ...state.workspaces,
                  [workspaceId]: {
                    ...ws,
                    linkedSessions: [...ws.linkedSessions, sessionId],
                  },
                },
              };
            }
            return state;
          });

          const systemPrompt = `You are a meticulous research assistant and conservative editor. Your PRIMARY objective is to synthesize new information from recent chat messages into a master Markdown document using XML commands.

CRITICAL INSTRUCTIONS:
1. SYNTHESIS FIRST: Always integrate new, relevant information into the appropriate sections or create new ones.
2. CONSERVATIVE CLEANUP: You may refine existing content to improve the document's utility.
   - Synthesize messy bullet points, merge redundant sections, and resolve contradictions caused by new information.
   - DO NOT rewrite sections that are already clear and logically sound. Leave them out of your response entirely.
3. XML COMMANDS: DO NOT output the full Markdown document. Only output the sections you are modifying.
   - To rewrite an existing top-level section: <update header="Exact Header Name">...new markdown...</update>
   - To add a brand new top-level section: <add header="New Header Name">...new markdown...</add>
   - To completely remove a redundant section: <delete header="Exact Header Name"></delete>
   - IMPORTANT: Do NOT include the top-level header itself (e.g., \`## Header Name\`) inside the XML tags. Start directly with the inner content. If you need sub-sections, use \`###\` or lower.
4. REQUIRED SECTION: ALWAYS maintain an "## Unanswered Questions & Recommended Searches" section near the bottom. Update it with new implications or remove questions that have been answered.
5. FORMATTING: Use bullet points, tables, and bold text for high readability. Ensure the header attribute EXACTLY matches the existing header name.

Original Document:
==================
${workspace.content}
==================
`;

          const userMessage = `Recent un-synced conversation history:\n\n${unsyncedMessages
            .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
            .join(
              "\n\n",
            )}\n\nPlease output the XML commands to update the document.`;

          const providerName = globalConfig.workspaceProviderName;
          const activeModel = globalConfig.workspaceModel;

          if (!providerName || !activeModel) {
            showToast(
              "Please configure Workspace Model and Provider in settings first.",
            );
            get().setSyncing(workspaceId, false);
            return;
          }

          const api = getClientApi(providerName as ServiceProvider);

          let updatedContent = "";
          let responseOk = false;

          await api.llm.chat({
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: userMessage },
            ],
            config: {
              ...globalConfig,
              model: activeModel,
              providerName: providerName as ServiceProvider,
              temperature: 1,
              max_tokens: 0,
              reasoningEffort: globalConfig.workspaceReasoningEffort || "",
              useStandardCompletion: true,
              suppressReasoningOutput: true,
              stream: false,
            },
            onUpdate(message) {
              // Not streaming
            },
            onFinish(message, responseRes) {
              if (!responseRes || responseRes.status === 200) {
                responseOk = true;
              }
              if (message) {
                updatedContent = message;
              }
            },
            onError(error) {
              console.error("[Workspace] Sync failed", error);
              const errMsg = error.message || "Unknown error";
              showToast("Workspace sync failed: " + errMsg);
              get().setSyncError(workspaceId, errMsg);
              get().setSyncing(workspaceId, false);
            },
            onController(controller) {},
          });

          if (
            responseOk &&
            updatedContent &&
            updatedContent.trim().length > 0
          ) {
            let cleanedContent = updatedContent.trim();

            // Failsafe: prevent saving raw JSON error strings disguised as successful responses
            if (
              cleanedContent.startsWith("{") &&
              cleanedContent.includes('"error"')
            ) {
              console.error(
                "[Workspace] Sync returned JSON error",
                cleanedContent,
              );
              showToast("Workspace sync failed: API returned an error object.");
              get().setSyncError(workspaceId, "API returned an error object.");
              return; // Skip updating document and sync index
            }

            // Remove markdown xml codeblock wrapping if model returns it
            if (cleanedContent.startsWith("```xml")) {
              cleanedContent = cleanedContent.replace(/^\`\`\`xml\n/i, "");
              cleanedContent = cleanedContent.replace(/\n\`\`\`$/i, "");
            }

            let newContent = workspace.content;
            const tagRegex =
              /<(update|add|delete)\s+header="([^"]+)">([\s\S]*?)(?:<\/\1>|$)/gi;

            let match;
            let tagsFound = false;

            while ((match = tagRegex.exec(cleanedContent)) !== null) {
              tagsFound = true;
              const action = match[1].toLowerCase();
              const header = match[2];
              const content = match[3]?.trim() || "";

              const escapeRegExp = (str: string) =>
                str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

              let finalContent = content.trim();
              if (action !== "delete") {
                const hasExactHeader = new RegExp(
                  `^#+\\s+${escapeRegExp(header)}(?:\\n|$)`,
                  "i",
                ).test(finalContent);

                if (!hasExactHeader) {
                  finalContent = `## ${header}\n\n${finalContent}`;
                }
              }

              if (action === "update" || action === "delete") {
                const escapedHeader = escapeRegExp(header);

                const headerMatchRegex = new RegExp(
                  "(^|\\n)(#+)\\s+" + escapedHeader + "\\s*(?=\\n|$)",
                  "i",
                );
                const headerMatchResult = headerMatchRegex.exec(newContent);

                if (headerMatchResult) {
                  const hashes = headerMatchResult[2];
                  const depth = hashes.length;
                  const blockRegex = new RegExp(
                    "(^|\\n)(" +
                      hashes +
                      "\\s+" +
                      escapedHeader +
                      "\\s*(?:\\n|\\r)[\\s\\S]*?)(?=(\\n#{1," +
                      depth +
                      "}\\s+)|$)",
                    "i",
                  );

                  if (blockRegex.test(newContent)) {
                    if (action === "delete") {
                      newContent = newContent.replace(
                        blockRegex,
                        (match, p1) => p1,
                      );
                    } else {
                      newContent = newContent.replace(
                        blockRegex,
                        (match, p1) => p1 + finalContent,
                      );
                    }
                  } else {
                    if (action === "update")
                      newContent += "\n\n" + finalContent;
                  }
                } else {
                  if (action === "update") newContent += "\n\n" + finalContent;
                }
              } else if (action === "add") {
                newContent += "\n\n" + finalContent;
              }
            }

            if (!tagsFound) {
              // Failsafe: Model failed to use XML tags, likely raw markdown.
              let fallbackContent = cleanedContent;
              if (fallbackContent.startsWith("```markdown")) {
                fallbackContent = fallbackContent.replace(
                  /^\`\`\`markdown\n/i,
                  "",
                );
                fallbackContent = fallbackContent.replace(/\n\`\`\`$/i, "");
              }
              newContent += `\n\n## Unsorted Updates\n\n${fallbackContent}`;
            }

            get().updateWorkspaceContent(workspaceId, newContent.trim(), true);
            get().setSyncError(workspaceId, undefined); // Clear error on success

            chatStore.updateTargetSession(session, (s) => {
              s.lastWorkspaceSyncMessageId = latestMessageId;
            });
          }
        } catch (e) {
          console.error("[Workspace] Sync exception", e);
        } finally {
          get().setSyncing(workspaceId, false);
        }
      },
    };

    return methods;
  },
  {
    name: "chat-next-web-workspace",
    version: 1,
  },
);
