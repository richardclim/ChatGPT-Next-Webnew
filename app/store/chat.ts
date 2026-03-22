import {
  getMessageTextContent,
  isDalle3,
  parseThinkingContent,
  safeLocalStorage,
  trimTopic,
} from "../utils";
import { useMemoryStore } from "./memory";
import type { ExtractionResult } from "./memory";

import { shallow } from "zustand/shallow";
import {
  indexedDBStorage,
  readPersistEnvelope,
  PersistEnvelope,
  attachStoragePingListener,
} from "@/app/utils/indexedDB-storage";
import { nanoid } from "nanoid";
import type {
  ClientApi,
  MultimodalContent,
  RequestMessage,
} from "../client/api";
import { getClientApi } from "../client/api";
import { ChatControllerPool } from "../client/controller";
import { showToast } from "../components/ui-lib";
import {
  DEFAULT_INPUT_TEMPLATE,
  DEFAULT_MODELS,
  DEFAULT_SYSTEM_TEMPLATE,
  GEMINI_SUMMARIZE_MODEL,
  DEEPSEEK_SUMMARIZE_MODEL,
  KnowledgeCutOffDate,
  MCP_SYSTEM_TEMPLATE,
  MCP_TOOLS_TEMPLATE,
  ServiceProvider,
  StoreKey,
  SUMMARIZE_MODEL,
  TAVILY_SYSTEM_TEMPLATE,
} from "../constant";
import Locale, { getLang } from "../locales";
import { prettyObject } from "../utils/format";
import { createPersistStore } from "../utils/store";
import { estimateTokenLength } from "../utils/token";
import { ModelConfig, ModelType, useAppConfig } from "./config";
import { useAccessStore } from "./access";
import { collectModelsWithDefaultModel } from "../utils/model";
import { createEmptyMask, Mask } from "./mask";
import { executeMcpAction, getAllTools, isMcpEnabled } from "../mcp/actions";
import { extractMcpJson, isMcpJson } from "../mcp/utils";

const localStorage = safeLocalStorage();

export type ChatMessageTool = {
  id: string;
  index?: number;
  type?: string;
  function?: {
    name: string;
    arguments?: string;
    [key: string]: any;
  };
  content?: string;
  isError?: boolean;
  errorMsg?: string;
};

export interface TimingInfo {
  reasoningDurationMs?: number;
  totalDurationMs?: number;
}

export type ChatMessage = RequestMessage & {
  date: string;
  streaming?: boolean;
  isError?: boolean;
  id: string;
  model?: ModelType;
  tools?: ChatMessageTool[];
  audio_url?: string;
  isMcpResponse?: boolean;
  isPasted?: boolean;
  gpt5PrevId?: string;
  memoryContext?: string;
  thinkingContent?: string;
  timingInfo?: TimingInfo;
};

export function createMessage(override: Partial<ChatMessage>): ChatMessage {
  return {
    id: nanoid(),
    date: new Date().toLocaleString(),
    role: "user",
    content: "",
    ...override,
  };
}

export interface ChatStat {
  tokenCount: number;
  wordCount: number;
  charCount: number;
}

export interface ChatSession {
  id: string;
  topic: string;

  memoryPrompt: string;
  messages: ChatMessage[];
  stat: ChatStat;
  lastUpdate: number;
  lastSummarizeIndex: number;
  clearContextIndex?: number;

  mask: Mask;
  pinned: boolean;
  pinnedAt?: number | null;

  lastArchivedContextId?: string;
  lastExtractionTime?: number;
  enableMemory?: boolean;

  lastEpisodicSummary?: string;
  lastEpisodicEntryId?: string;

  // Soft-delete tombstone: timestamp when session was deleted.
  // Undefined/absent means the session is alive.
  deletedAt?: number;

  // Per-session draft input text, persisted across refreshes and cloud sync.
  draftInput?: string;
}

export const DEFAULT_TOPIC = Locale.Store.DefaultTopic;
export const BOT_HELLO: ChatMessage = createMessage({
  role: "assistant",
  content: Locale.Store.BotHello,
});

function createEmptySession(): ChatSession {
  return {
    id: nanoid(),
    topic: DEFAULT_TOPIC,
    memoryPrompt: "",
    messages: [],
    stat: {
      tokenCount: 0,
      wordCount: 0,
      charCount: 0,
    },
    lastUpdate: Date.now(),
    lastSummarizeIndex: 0,

    mask: createEmptyMask(),
    pinned: false,
    pinnedAt: null,

    enableMemory: true,
    lastArchivedContextId: undefined,
    lastExtractionTime: undefined,
    lastEpisodicSummary: undefined,
    lastEpisodicEntryId: undefined,
    draftInput: "",
  };
}

/**
 * Pure function that applies extraction result metadata to session fields.
 * Used by triggerExtractionForSession to update the session atomically.
 */
export function applyExtractionResult(
  session: Pick<
    ChatSession,
    | "lastArchivedContextId"
    | "lastExtractionTime"
    | "lastEpisodicSummary"
    | "lastEpisodicEntryId"
  >,
  result: ExtractionResult,
): void {
  session.lastArchivedContextId = result.lastMessageId;
  session.lastExtractionTime = Date.now();
  if (result.episodicSummary !== undefined) {
    session.lastEpisodicSummary = result.episodicSummary;
  }
  if (result.entryId !== undefined) {
    session.lastEpisodicEntryId = result.entryId;
  }
}

function getSummarizeModel(
  currentModel: string,
  providerName: string,
): string[] {
  // if it is using gpt-* models, force to use 4o-mini to summarize
  if (currentModel.startsWith("gpt") || currentModel.startsWith("chatgpt")) {
    const configStore = useAppConfig.getState();
    const accessStore = useAccessStore.getState();
    const allModel = collectModelsWithDefaultModel(
      configStore.models,
      [configStore.customModels, accessStore.customModels].join(","),
      accessStore.defaultModel,
    );
    const summarizeModel = allModel.find(
      (m) => m.name === SUMMARIZE_MODEL && m.available,
    );
    if (summarizeModel) {
      return [
        summarizeModel.name,
        summarizeModel.provider?.providerName as string,
      ];
    }
  }
  if (currentModel.startsWith("gemini")) {
    return [GEMINI_SUMMARIZE_MODEL, ServiceProvider.Google];
  } else if (currentModel.startsWith("deepseek-")) {
    return [DEEPSEEK_SUMMARIZE_MODEL, ServiceProvider.DeepSeek];
  }

  return [currentModel, providerName];
}

/** Strip `> ` blockquoted thinking lines from assistant message content */
function stripThinkingFromMessages(msgs: ChatMessage[]): ChatMessage[] {
  return msgs.map((msg) => {
    if (msg.role === "assistant" && typeof msg.content === "string") {
      return { ...msg, content: parseThinkingContent(msg.content).output };
    }
    return msg;
  });
}

function countMessages(msgs: ChatMessage[]) {
  return msgs.reduce(
    (pre, cur) => pre + estimateTokenLength(getMessageTextContent(cur)),
    0,
  );
}

function fillTemplateWith(input: string, modelConfig: ModelConfig) {
  const cutoff =
    KnowledgeCutOffDate[modelConfig.model] ?? KnowledgeCutOffDate.default;
  // Find the model in the DEFAULT_MODELS array that matches the modelConfig.model
  const modelInfo = DEFAULT_MODELS.find((m) => m.name === modelConfig.model);

  var serviceProvider = "OpenAI";
  if (modelInfo) {
    // TODO: auto detect the providerName from the modelConfig.model

    // Directly use the providerName from the modelInfo
    serviceProvider = modelInfo.provider.providerName;
  }

  const vars = {
    ServiceProvider: serviceProvider,
    cutoff,
    model: modelConfig.model,
    time: new Date().toString(),
    lang: getLang(),
    input: input,
  };

  let output = modelConfig.template ?? DEFAULT_INPUT_TEMPLATE;

  // remove duplicate
  if (input.startsWith(output)) {
    output = "";
  }

  // must contains {{input}}
  const inputVar = "{{input}}";
  if (!output.includes(inputVar)) {
    output += "\n" + inputVar;
  }

  Object.entries(vars).forEach(([name, value]) => {
    const regex = new RegExp(`{{${name}}}`, "g");
    output = output.replace(regex, value.toString()); // Ensure value is a string
  });

  return output;
}

async function getMcpSystemPrompt(): Promise<string> {
  const tools = await getAllTools();

  let toolsStr = "";

  tools.forEach((i) => {
    // error client has no tools
    if (!i.tools) return;

    toolsStr += MCP_TOOLS_TEMPLATE.replace(
      "{{ clientId }}",
      i.clientId,
    ).replace(
      "{{ tools }}",
      i.tools.tools.map((p: object) => JSON.stringify(p, null, 2)).join("\n"),
    );
  });

  return MCP_SYSTEM_TEMPLATE.replace("{{ MCP_TOOLS }}", toolsStr);
}

// Tombstone retention: purge soft-deleted sessions older than 30 days
const TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function isSessionAlive(s: ChatSession): boolean {
  return !s.deletedAt;
}

function purgeTombstones(tombstones: ChatSession[]): ChatSession[] {
  const cutoff = Date.now() - TOMBSTONE_TTL_MS;
  return tombstones.filter((s) => (s.deletedAt ?? 0) > cutoff);
}

function isPlaceholderSession(s: ChatSession): boolean {
  return (
    !!s &&
    !s.deletedAt &&
    (s.messages?.length ?? 0) === 0 &&
    s.topic === DEFAULT_TOPIC &&
    !s.pinned &&
    !s.memoryPrompt
  );
}

function stripOnlyPlaceholder(sessions: ChatSession[]): ChatSession[] {
  return sessions.length === 1 && isPlaceholderSession(sessions[0])
    ? []
    : sessions;
}

const DEFAULT_CHAT_STATE = {
  sessions: [createEmptySession()],
  // Tombstones: soft-deleted sessions kept for cross-tab merge conflict resolution.
  // Stored separately so UI code using index-based session access is unaffected.
  _tombstones: [] as ChatSession[],
  currentSessionIndex: 0,
  lastInput: "",
  isMenuOpen: false,
  menuPosition: { top: 0, left: 0 },
  menuSessionId: null as string | null,
  _rev: 0,
  _inFlight: 0,
  _pendingExternalHydrate: false,
};

function sortSessions(
  sessions: ChatSession[],
  currentSessionId?: string,
): { sortedSessions: ChatSession[]; newIndex: number } {
  const pinnedSessions = sessions
    .filter((s) => s.pinned)
    .sort((a, b) => {
      const timeA = a.pinnedAt ?? 0;
      const timeB = b.pinnedAt ?? 0;
      return timeB - timeA;
    });

  const unpinnedSessions = sessions
    .filter((s) => !s.pinned)
    .sort((a, b) => b.lastUpdate - a.lastUpdate);

  const sortedSessions = [...pinnedSessions, ...unpinnedSessions];
  // Math.max(0, -1) results in 0, selecting the first session by default.
  const newIndex = Math.max(
    0,
    sortedSessions.findIndex((s) => s.id === currentSessionId),
  );

  return { sortedSessions, newIndex };
}

const CHAT_TAB_ID_KEY = "chat_tab_id";
const CHAT_TAB_SESSION_KEY = "chat_current_session_id"; // Per-tab session persistence
const CHAT_TAB_ID = (() => {
  try {
    const v =
      sessionStorage.getItem(CHAT_TAB_ID_KEY) ||
      crypto.randomUUID?.() ||
      Math.random().toString(36).slice(2);
    sessionStorage.setItem(CHAT_TAB_ID_KEY, v);
    return v;
  } catch {
    return Math.random().toString(36).slice(2);
  }
})();

// Helper to persist the current session ID for this tab
function setTabCurrentSessionId(sessionId: string) {
  try {
    sessionStorage.setItem(CHAT_TAB_SESSION_KEY, sessionId);
  } catch (e) {
    console.warn("[Chat] Failed to save session ID to sessionStorage", e);
  }
}

// Helper to retrieve the persisted session ID for this tab
function getTabCurrentSessionId(): string | null {
  try {
    return sessionStorage.getItem(CHAT_TAB_SESSION_KEY);
  } catch {
    return null;
  }
}

function toTs(dateStr?: string) {
  if (!dateStr) return 0;
  const t = Date.parse(dateStr);
  return Number.isFinite(t) ? t : 0;
}

// Reconcile messages by id (prefer streaming from local; else newer date)
function mergeMessages(
  local: ChatMessage[],
  remote: ChatMessage[],
): ChatMessage[] {
  const lm = new Map(local.map((m) => [m.id, m]));
  const rm = new Map(remote.map((m) => [m.id, m]));
  const ids = new Set<string>([...lm.keys(), ...rm.keys()]);
  const merged: ChatMessage[] = [];
  for (const id of ids) {
    const a = lm.get(id);
    const b = rm.get(id);
    if (a && !b) {
      merged.push(a);
    } else if (!a && b) {
      merged.push(b);
    } else if (a && b) {
      if (a.streaming && !b.streaming) {
        merged.push(a);
      } else if (!a.streaming && b.streaming) {
        merged.push(a); // prefer finished local over remote streaming
      } else {
        // both finished or both non-streaming
        merged.push(toTs(a.date) >= toTs(b.date) ? a : b);
      }
    }
  }
  // sort by date ascending
  merged.sort((x, y) => toTs(x.date) - toTs(y.date));
  return merged;
}

// Reconcile sessions + tombstones across local and remote.
// Returns { sessions, tombstones } with conflicts resolved.
function mergeSessions(
  localSessions: ChatSession[],
  localTombstones: ChatSession[],
  remoteSessions: ChatSession[],
  remoteTombstones: ChatSession[],
): { sessions: ChatSession[]; tombstones: ChatSession[] } {
  // Build tombstone maps (id → tombstone record)
  const localTombMap = new Map(localTombstones.map((t) => [t.id, t]));
  const remoteTombMap = new Map(remoteTombstones.map((t) => [t.id, t]));

  // Build local live session map
  const localMap = new Map(localSessions.map((s) => [s.id, s]));

  const resultSessions: ChatSession[] = [];
  const resultTombstones: ChatSession[] = [];
  const seen = new Set<string>();

  // Pass 1: iterate remote live sessions
  for (const R of remoteSessions) {
    seen.add(R.id);
    const L = localMap.get(R.id);
    const localTomb = localTombMap.get(R.id);

    if (localTomb) {
      // Local deleted this session — tombstone wins
      resultTombstones.push(localTomb);
      continue;
    }

    if (!L) {
      // Remote-only session, not tombstoned locally — keep it
      resultSessions.push(R);
      continue;
    }

    // Both sides have it live — merge
    const newer = (L.lastUpdate ?? 0) >= (R.lastUpdate ?? 0) ? L : R;
    const messages = mergeMessages(L.messages, R.messages);

    resultSessions.push({
      ...newer,
      messages,
      pinned: (L.pinnedAt ?? 0) >= (R.pinnedAt ?? 0) ? L.pinned : R.pinned,
      pinnedAt: Math.max(L.pinnedAt ?? 0, R.pinnedAt ?? 0) || null,
      topic: (L.lastUpdate ?? 0) >= (R.lastUpdate ?? 0) ? L.topic : R.topic,
      memoryPrompt:
        (L.lastUpdate ?? 0) >= (R.lastUpdate ?? 0)
          ? L.memoryPrompt
          : R.memoryPrompt,
      lastUpdate: Math.max(L.lastUpdate, R.lastUpdate),
      lastSummarizeIndex: Math.max(
        L.lastSummarizeIndex ?? 0,
        R.lastSummarizeIndex ?? 0,
      ),
      clearContextIndex:
        Math.max(L.clearContextIndex ?? 0, R.clearContextIndex ?? 0) ||
        undefined,
      // Prefer local draft (this tab is actively typing); fall back to remote
      draftInput: L.draftInput || R.draftInput,
    });
  }

  // Pass 2: add local-only live sessions (not in remote, not tombstoned remotely)
  for (const [id, L] of localMap) {
    if (seen.has(id)) continue; // already handled
    const remoteTomb = remoteTombMap.get(id);
    if (remoteTomb) {
      // Remote deleted this session — tombstone wins
      resultTombstones.push(remoteTomb);
    } else {
      resultSessions.push(L);
    }
  }

  // Pass 3: merge tombstones from both sides (union, keep latest deletedAt)
  const tombMap = new Map<string, ChatSession>();
  for (const t of [...localTombstones, ...remoteTombstones]) {
    const existing = tombMap.get(t.id);
    if (!existing || (t.deletedAt ?? 0) > (existing.deletedAt ?? 0)) {
      tombMap.set(t.id, t);
    }
  }
  // Only keep tombstones that aren't already in resultTombstones
  const resultTombIds = new Set(resultTombstones.map((t) => t.id));
  for (const [id, t] of tombMap) {
    if (!resultTombIds.has(id)) {
      resultTombstones.push(t);
    }
  }

  return { sessions: resultSessions, tombstones: resultTombstones };
}

// Merge whole chat store (excluding ephemeral UI fields)
function reconcileChatStore(
  localState: typeof DEFAULT_CHAT_STATE,
  remoteState: typeof DEFAULT_CHAT_STATE,
): typeof DEFAULT_CHAT_STATE {
  if (!remoteState) return localState;

  // Merge sessions + tombstones
  const { sessions: mergedSessions, tombstones: mergedTombstones } =
    mergeSessions(
      localState.sessions,
      localState._tombstones ?? [],
      remoteState.sessions ?? [],
      remoteState._tombstones ?? [],
    );

  // Purge tombstones older than retention period
  const cleanedTombstones = purgeTombstones(mergedTombstones);

  // Keep current session by id if possible
  const currentId = localState.sessions[localState.currentSessionIndex]?.id;
  const { sortedSessions, newIndex } = sortSessions(mergedSessions, currentId);

  // Choose lastInput: prefer local (more recent UI input)
  const lastInput = localState.lastInput || "";

  return {
    ...localState,
    sessions: sortedSessions,
    _tombstones: cleanedTombstones,
    currentSessionIndex: newIndex,
    lastInput,
    isMenuOpen: localState.isMenuOpen,
    menuPosition: localState.menuPosition,
    menuSessionId: localState.menuSessionId,
  };
}

// Filter persisted snapshot: remove streaming and ephemeral fields
function partializeChatState(
  s: typeof DEFAULT_CHAT_STATE,
): typeof DEFAULT_CHAT_STATE {
  const prunedSessions = s.sessions.map((sess) => ({
    ...sess,
    messages: sess.messages.filter((m) => !m.streaming),
  }));

  return {
    ...s,
    sessions: prunedSessions,
    // Tombstones are already lightweight (no messages/memoryPrompt)
    _tombstones: s._tombstones ?? [],
    // DO NOT persist cross-tab fields (we set them on boot)
    _rev: undefined as any,
    _inFlight: undefined as any,
    _pendingExternalHydrate: undefined as any,
    // Per-tab UI state should not be persisted/synced across tabs
    lastInput: undefined as any,
    currentSessionIndex: undefined as any,
    isMenuOpen: undefined as any,
    menuPosition: undefined as any,
    menuSessionId: undefined as any,
  };
}

export const useChatStore = createPersistStore(
  DEFAULT_CHAT_STATE,
  (set, _get) => {
    function get() {
      return {
        ..._get(),
        ...methods,
      };
    }
    const EXTRACTION_DEBOUNCE_MS = 30 * 1000; // 30 seconds debounce

    const methods = {
      async triggerExtractionForSession(session: ChatSession) {
        if (!session.enableMemory || session.messages.length === 0) return;

        // Debounce: skip if extraction ran recently for this session
        const now = Date.now();
        if (
          session.lastExtractionTime &&
          now - session.lastExtractionTime < EXTRACTION_DEBOUNCE_MS
        ) {
          console.log(
            "[Chat] Skipping extraction - debounce period not elapsed",
          );
          return;
        }

        const memoryStore = useMemoryStore.getState();
        const result = await memoryStore.processExtraction(
          session.messages,
          session.id,
          session.lastArchivedContextId,
          session.lastEpisodicSummary,
          session.lastEpisodicEntryId,
        );

        if (result) {
          get().updateTargetSession(session, (s) => {
            applyExtractionResult(s, result);
          });
          console.log(
            "[Chat] Extraction complete, updated lastArchivedContextId:",
            result.lastMessageId,
          );
        }
      },
      async rehydrateFromDiskAndMerge() {
        const name = StoreKey.Chat;
        const env = await readPersistEnvelope(name);
        if (!env) return;

        const persistedState = env.state as typeof DEFAULT_CHAT_STATE;
        const rev = Number(env.rev || 0);

        const current = _get() as any;
        if (rev <= (current._rev || 0)) return;

        // If the persisted portion of state is identical to our current persisted view,
        // only bump _rev to avoid unnecessary set/persist cycles.
        try {
          const currentPersisted = partializeChatState(current as any);
          if (
            JSON.stringify(currentPersisted) === JSON.stringify(persistedState)
          ) {
            set((state) => ({ ...state, _rev: rev }));
            return;
          }
        } catch {}

        set((state) => {
          const hasPersistedSessions =
            Array.isArray(persistedState.sessions) &&
            persistedState.sessions.length > 0;
          const base = hasPersistedSessions
            ? { ...state, sessions: stripOnlyPlaceholder(state.sessions ?? []) }
            : state;
          const merged = reconcileChatStore(base, persistedState);
          return {
            ...merged,
            _rev: rev,
          };
        });
      },

      initCrossTabSync() {
        const name = StoreKey.Chat;
        // BroadcastChannel
        const bc =
          typeof window !== "undefined" && "BroadcastChannel" in window
            ? new BroadcastChannel(`${name}:bc`)
            : null;

        const onExternalPersist = async (msg: any) => {
          if (
            !msg ||
            msg.from === CHAT_TAB_ID ||
            msg.type !== "persisted" ||
            msg.key !== name
          )
            return;
          const s = _get() as any;
          if ((s._inFlight || 0) > 0) {
            set({ _pendingExternalHydrate: true });
            return;
          }
          await (get() as any).rehydrateFromDiskAndMerge();
        };

        bc?.addEventListener("message", (evt) => onExternalPersist(evt.data));

        // Fallback to storage event for tabs without BroadcastChannel
        attachStoragePingListener(name, onExternalPersist);
      },

      openMenu(sessionId: string, position: { top: number; left: number }) {
        set({
          isMenuOpen: true,
          menuSessionId: sessionId,
          menuPosition: position,
        });
      },

      closeMenu() {
        set({
          isMenuOpen: false,
          menuSessionId: null,
        });
      },

      pinSession(index: number) {
        set((state) => {
          if (index < 0 || index >= state.sessions.length) return state;

          const updatedSession = state.sessions.map((session, i) => {
            if (i === index) {
              return { ...session, pinned: true, pinnedAt: Date.now() };
            }
            return session;
          });

          const currentSessionId =
            state.sessions[state.currentSessionIndex]?.id;
          const { sortedSessions, newIndex } = sortSessions(
            updatedSession,
            currentSessionId,
          );

          return {
            sessions: sortedSessions,
            currentSessionIndex: newIndex,
          };
        });
      },

      updateSessionTopic(sessionIndex: number, newTopic: string) {
        set((state) => {
          const sessions = [...state.sessions];
          if (sessionIndex < 0 || sessionIndex >= sessions.length) return state;

          const sessionToUpdate = sessions[sessionIndex];
          sessionToUpdate.topic = newTopic;

          return {
            sessions,
          };
        });
      },

      unpinSession(index: number) {
        set((state) => {
          if (index < 0 || index >= state.sessions.length) return state;

          const updatedSession = state.sessions.map((session, i) => {
            if (i === index) {
              return { ...session, pinned: false, pinnedAt: null };
            }
            return session;
          });

          const currentSessionId =
            state.sessions[state.currentSessionIndex]?.id;
          const { sortedSessions, newIndex } = sortSessions(
            updatedSession,
            currentSessionId,
          );

          return {
            sessions: sortedSessions,
            currentSessionIndex: newIndex,
          };
        });
      },

      forkSession() {
        // 获取当前会话
        const currentSession = get().currentSession();
        if (!currentSession) return;

        const newSession = createEmptySession();

        newSession.topic = currentSession.topic;
        // 深拷贝消息
        newSession.messages = currentSession.messages.map((msg) => ({
          ...msg,
          id: nanoid(), // 生成新的消息 ID
        }));
        newSession.mask = {
          ...currentSession.mask,
          modelConfig: {
            ...currentSession.mask.modelConfig,
          },
        };

        set((state) => ({
          currentSessionIndex: 0,
          sessions: [newSession, ...state.sessions],
        }));

        // Persist the forked session ID for this tab
        setTabCurrentSessionId(newSession.id);
      },

      clearSessions() {
        const now = Date.now();
        const newTombstones = get().sessions.map((s) => ({
          ...s,
          deletedAt: now,
          pinned: false,
          messages: [] as ChatMessage[],
          memoryPrompt: "",
        }));
        const tombstones = [...(get() as any)._tombstones, ...newTombstones];
        const newSession = createEmptySession();
        set(() => ({
          sessions: [newSession],
          _tombstones: tombstones,
          currentSessionIndex: 0,
        }));
        // Persist the new session ID for this tab
        setTabCurrentSessionId(newSession.id);
      },

      selectSession(index: number) {
        // Trigger extraction on the previous session before switching
        const previousSession = get().currentSession();
        if (previousSession && previousSession.messages.length > 0) {
          get().triggerExtractionForSession(previousSession);
        }

        set({
          currentSessionIndex: index,
        });

        // Persist the selected session ID to sessionStorage for this tab
        const sessions = get().sessions;
        if (sessions[index]) {
          setTabCurrentSessionId(sessions[index].id);
        }
      },

      moveSession(from: number, to: number) {
        set((state) => {
          const { sessions, currentSessionIndex: oldIndex } = state;

          // move the session
          const newSessions = [...sessions];
          const session = newSessions[from];
          newSessions.splice(from, 1);
          newSessions.splice(to, 0, session);

          // modify current session id
          let newIndex = oldIndex === from ? to : oldIndex;
          if (oldIndex > from && oldIndex <= to) {
            newIndex -= 1;
          } else if (oldIndex < from && oldIndex >= to) {
            newIndex += 1;
          }

          return {
            currentSessionIndex: newIndex,
            sessions: newSessions,
          };
        });
      },

      newSession(mask?: Mask) {
        // Trigger extraction for current session before creating new one
        const currentSession = get().currentSession();
        if (currentSession && currentSession.messages.length > 0) {
          get().triggerExtractionForSession(currentSession);
        }

        const session = createEmptySession();

        if (mask) {
          const config = useAppConfig.getState();
          const globalModelConfig = config.modelConfig;

          session.mask = {
            ...mask,
            modelConfig: {
              ...globalModelConfig,
              ...mask.modelConfig,
            },
          };
          session.topic = mask.name;
        }

        set((state) => ({
          currentSessionIndex: 0,
          sessions: [session].concat(state.sessions),
        }));

        // Persist the new session ID for this tab
        setTabCurrentSessionId(session.id);
      },

      nextSession(delta: number) {
        const n = get().sessions.length;
        const limit = (x: number) => (x + n) % n;
        const i = get().currentSessionIndex;
        get().selectSession(limit(i + delta));
      },

      deleteSession(index: number) {
        const deletingLastSession = get().sessions.length === 1;
        const deletedSession = get().sessions.at(index);

        if (!deletedSession) return;

        // Remove from sessions, add to tombstones
        const sessions = get().sessions.slice();
        sessions.splice(index, 1);

        const tombstone: ChatSession = {
          ...deletedSession,
          deletedAt: Date.now(),
          pinned: false,
          messages: [], // strip heavy data from tombstone
          memoryPrompt: "",
        };
        const tombstones = [...(get() as any)._tombstones, tombstone];

        const currentIndex = get().currentSessionIndex;
        let nextIndex = Math.min(
          currentIndex - Number(index < currentIndex),
          sessions.length - 1,
        );

        if (deletingLastSession) {
          nextIndex = 0;
          sessions.push(createEmptySession());
        }

        // for undo delete action
        const restoreState = {
          currentSessionIndex: get().currentSessionIndex,
          sessions: get().sessions.slice(),
          _tombstones: (get() as any)._tombstones.slice(),
        };

        set(() => ({
          currentSessionIndex: nextIndex,
          sessions,
          _tombstones: tombstones,
        }));

        // Persist the new current session ID for this tab
        if (sessions[nextIndex]) {
          setTabCurrentSessionId(sessions[nextIndex].id);
        }

        showToast(
          Locale.Home.DeleteToast,
          {
            text: Locale.Home.Revert,
            onClick() {
              set(() => restoreState);
            },
          },
          5000,
        );
      },

      currentSession() {
        let index = get().currentSessionIndex;
        const sessions = get().sessions;

        if (index < 0 || index >= sessions.length) {
          index = Math.min(sessions.length - 1, Math.max(0, index));
          set(() => ({ currentSessionIndex: index }));
        }

        const session = sessions[index];

        return session;
      },

      onNewMessage(message: ChatMessage, targetSession: ChatSession) {
        get().updateTargetSession(targetSession, (session) => {
          session.messages = session.messages.concat();
          session.lastUpdate = Date.now();
        });

        set((state) => {
          const currentId = state.sessions[state.currentSessionIndex]?.id;

          const { sortedSessions, newIndex } = sortSessions(
            [...state.sessions],
            currentId,
          );
          return {
            sessions: sortedSessions,
            currentSessionIndex: newIndex,
          };
        });

        get().updateStat(message, targetSession);

        get().checkMcpJson(message);

        get().summarizeSession(false, targetSession);

        // Check if we should trigger extraction (every 8 new messages)
        const session = get().sessions.find((s) => s.id === targetSession.id);
        if (session && session.enableMemory) {
          const archiveIndex = session.lastArchivedContextId
            ? session.messages.findIndex(
                (m) => m.id === session.lastArchivedContextId,
              )
            : -1;
          const newMessageCount =
            archiveIndex >= 0
              ? session.messages.length - archiveIndex - 1
              : session.messages.length;

          // 4 user + 4 assistant = 8 messages
          if (newMessageCount >= 8) {
            console.log(
              "[Chat] Triggering extraction - 8+ new messages detected",
            );
            get().triggerExtractionForSession(session);
          }
        }
      },

      async onUserInput(
        content: string,
        attachImages?: string[],
        isMcpResponse?: boolean,
        isPasted?: boolean, // Added isPasted parameter
        attachFiles?: { url: string; name: string; mimeType: string }[],
      ) {
        const session = get().currentSession();
        // increment in-flight count when starting a new assistant stream
        set((s) => ({ ...s, _inFlight: (s as any)._inFlight + 1 }));
        try {
          const modelConfig = session.mask.modelConfig;

          // MCP Response no need to fill template
          let mContent: string | MultimodalContent[] = isMcpResponse
            ? content
            : fillTemplateWith(content, modelConfig);

          const hasAttachments =
            (!isMcpResponse && attachImages && attachImages.length > 0) ||
            (attachFiles && attachFiles.length > 0);

          if (hasAttachments) {
            mContent = [
              ...(content ? [{ type: "text" as const, text: content }] : []),
              ...(attachImages ?? []).map((url) => ({
                type: "image_url" as const,
                image_url: { url },
              })),
              ...(attachFiles ?? []).map((f) => ({
                type: "file" as const,
                file: f,
              })),
            ];
          }

          let userMessage: ChatMessage = createMessage({
            role: "user",
            content: mContent,
            isMcpResponse,
            isPasted,
          });

          // Memory Logic: Retrieve and attach memory context if enabled (and not pasted/MCP)
          const memoryStore = useMemoryStore.getState();
          if (
            !isMcpResponse &&
            !isPasted &&
            memoryStore.enabled &&
            session.enableMemory &&
            content
          ) {
            try {
              // Collect memoryContext from previous messages to avoid duplicate retrieval
              const previousMemoryContexts = session.messages
                .filter((m) => m.role === "user" && m.memoryContext)
                .map((m) => m.memoryContext as string);

              // Last few messages for query expander reference resolution (pronouns like "it", "that")
              const recentMessages = session.messages.slice(-4);

              const [relevant, episodic] = await Promise.all([
                memoryStore.findRelevant(content, previousMemoryContexts),
                memoryStore.retrieveEpisodicMemory(
                  content,
                  5,
                  recentMessages,
                  previousMemoryContexts,
                ),
              ]);
              const episodicStr =
                episodic && episodic.length > 0 ? episodic.join("\n\n") : "";

              const memoryContext = [
                relevant ? `User Profile:\n${relevant}` : "",
                episodicStr ? `Recalled Memory:\n${episodicStr}` : "",
              ]
                .filter(Boolean)
                .join("\n\n");

              if (memoryContext) {
                userMessage.memoryContext = memoryContext;
                console.log("[Chat] Attached memory context to user message");
              }
            } catch (e) {
              console.error("[Chat] Failed to retrieve memory", e);
            }
          }

          // If message is pasted, add it to messages and return early.
          if (userMessage.isPasted) {
            get().updateTargetSession(session, (session) => {
              session.messages = session.messages.concat([userMessage]);
              session.lastUpdate = Date.now();
            });
            get().updateStat(userMessage, session);
            // No bot message needed if user message is pasted and we are stopping here.
            // Or, if it's a pasted response, both messages are created in chat.tsx.
            // This early return prevents API call.
            return;
          }

          const botMessage: ChatMessage = createMessage({
            role: "assistant",
            streaming: true,
            model: modelConfig.model,
          });

          // get recent messages
          const recentMessages = await get().getMessagesWithMemory();
          // Inject memoryContext into the current user message for the API call
          const outgoingUserMessage =
            userMessage.memoryContext && typeof userMessage.content === "string"
              ? {
                  ...userMessage,
                  content: `Context:\n${userMessage.memoryContext}\n\nQuestion:\n${userMessage.content}`,
                }
              : userMessage;
          const sendMessages = recentMessages.concat(outgoingUserMessage);
          const messageIndex = session.messages.length + 1;
          const isNewChat = session.messages.length === 0;

          // save user's and bot's message
          get().updateTargetSession(session, (session) => {
            const savedUserMessage = {
              ...userMessage,
              content: mContent,
            };
            session.messages = session.messages.concat([
              savedUserMessage,
              botMessage,
            ]);
          });

          const api: ClientApi = getClientApi(modelConfig.providerName);

          // External Model Logic
          if (modelConfig.model === "aistudio") {
            // Since aistudio doesn't use message arrays, we prepend context directly to content
            let aiStudioContent: string | MultimodalContent[] = mContent;
            if (userMessage.memoryContext && typeof mContent === "string") {
              aiStudioContent = `Context:\n${userMessage.memoryContext}\n\nQuestion:\n${mContent}`;
              console.log(
                "[Chat] AIStudio: Injected memory context into content",
              );
            } else if (userMessage.memoryContext && Array.isArray(mContent)) {
              // For multimodal content, prepend context as text
              const contextText = {
                type: "text" as const,
                text: `Context:\n${userMessage.memoryContext}\n\nQuestion:\n`,
              };
              aiStudioContent = [contextText, ...mContent];
              console.log(
                "[Chat] AIStudio: Injected memory context into multimodal content",
              );
            }

            // make request to local api
            try {
              const queueRes = await fetch("/api/external-chat", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  action: "queue",
                  id: userMessage.id,
                  content: aiStudioContent,
                  model: modelConfig.model,
                  isNewChat,
                }),
              });
              if (!queueRes.ok) {
                throw new Error(`Failed to queue request: ${queueRes.status}`);
              }
            } catch (e) {
              console.error("Failed to queue external chat request:", e);
              botMessage.streaming = false;
              botMessage.content =
                "Error: Failed to send request to AI Studio bridge";
              botMessage.isError = true;
              get().updateTargetSession(session, (session) => {
                session.messages = session.messages.concat();
              });
              set((s) => {
                const next = Math.max(0, (s as any)._inFlight - 1);
                return { ...s, _inFlight: next };
              });
              return;
            }

            // poll for response
            const pollInterval = setInterval(async () => {
              try {
                const res = await fetch("/api/external-chat", {
                  method: "POST",
                  body: JSON.stringify({
                    action: "poll_response",
                  }),
                });
                const data = await res.json();
                if (
                  data.success &&
                  data.response &&
                  data.response.id === userMessage.id
                ) {
                  clearInterval(pollInterval);

                  botMessage.streaming = false;
                  botMessage.content = data.response.content;
                  botMessage.date = new Date().toLocaleString();

                  // Sync title from external AI if present and non-empty
                  if (data.response.title && data.response.title.trim()) {
                    get().updateTargetSession(session, (session) => {
                      session.topic = data.response.title.trim();
                    });
                  }

                  get().onNewMessage(botMessage, session);

                  ChatControllerPool.remove(session.id, botMessage.id);
                  set((s) => {
                    const next = Math.max(0, (s as any)._inFlight - 1);
                    return { ...s, _inFlight: next };
                  });
                }
              } catch (e) {
                console.error("Polling error", e);
              }
            }, 1000);

            // Add a controller to stop polling if needed
            ChatControllerPool.addController(
              session.id,
              botMessage.id ?? messageIndex,
              {
                stop: () => clearInterval(pollInterval),
              } as any,
            );

            return;
          }

          // make request
          api.llm.chat({
            messages: sendMessages,
            config: { ...modelConfig, stream: true },
            onUpdate(message) {
              botMessage.streaming = true;
              if (message) {
                botMessage.content = message;
              }
              get().updateTargetSession(session, (session) => {
                session.messages = session.messages.concat();
              });
            },
            async onFinish(
              message,
              res,
              thinkingText?,
              timingInfo?,
              gpt5PrevId?,
            ) {
              botMessage.streaming = false;
              if (message) {
                botMessage.date = new Date().toLocaleString();

                if (thinkingText) {
                  botMessage.thinkingContent = thinkingText;
                  // Strip blockquoted thinking lines from the main content
                  // to avoid duplication (thinking is already in thinkingContent)
                  botMessage.content = parseThinkingContent(message).output;
                } else {
                  botMessage.content = message;
                }
                if (timingInfo) {
                  botMessage.timingInfo = timingInfo;
                }
                if (gpt5PrevId) {
                  botMessage.gpt5PrevId = gpt5PrevId;
                }
                get().onNewMessage(botMessage, session);
              }
              ChatControllerPool.remove(session.id, botMessage.id);
              // decrement in-flight and perform deferred hydrate if needed
              set((s) => {
                const next = Math.max(0, (s as any)._inFlight - 1);
                return { ...s, _inFlight: next };
              });

              const st = _get() as any;
              if (st._inFlight === 0 && st._pendingExternalHydrate) {
                await (get() as any).rehydrateFromDiskAndMerge();
                set({ _pendingExternalHydrate: false });
              }
            },

            onBeforeTool(tool: ChatMessageTool) {
              (botMessage.tools = botMessage?.tools || []).push(tool);
              get().updateTargetSession(session, (session) => {
                session.messages = session.messages.concat();
              });
            },
            onAfterTool(tool: ChatMessageTool) {
              botMessage?.tools?.forEach((t, i, tools) => {
                if (tool.id == t.id) {
                  tools[i] = { ...tool };
                }
              });
              get().updateTargetSession(session, (session) => {
                session.messages = session.messages.concat();
              });
            },
            onError(error) {
              const isAborted = error.message?.includes?.("aborted");
              botMessage.content +=
                "\n\n" +
                prettyObject({
                  error: true,
                  message: error.message,
                });
              botMessage.streaming = false;
              userMessage.isError = !isAborted;
              botMessage.isError = !isAborted;
              get().updateTargetSession(session, (session) => {
                session.messages = session.messages.concat();
              });
              ChatControllerPool.remove(
                session.id,
                botMessage.id ?? messageIndex,
              );

              console.error("[Chat] failed ", error);
              // decrement in-flight and perform deferred hydrate if needed
              set((s) => {
                const next = Math.max(0, (s as any)._inFlight - 1);
                return { ...s, _inFlight: next };
              });
              const st = _get() as any;
              if (st._inFlight === 0 && st._pendingExternalHydrate) {
                (get() as any).rehydrateFromDiskAndMerge().then(() => {
                  set({ _pendingExternalHydrate: false });
                });
              }
            },
            onController(controller) {
              // collect controller for stop/retry
              ChatControllerPool.addController(
                session.id,
                botMessage.id ?? messageIndex,
                controller,
              );
            },
          });
        } catch (e) {
          set((s) => {
            const next = Math.max(0, (s as any)._inFlight - 1);
            return { ...s, _inFlight: next };
          });
          throw e;
        }
      },

      getMemoryPrompt() {
        const session = get().currentSession();

        if (session.memoryPrompt.length) {
          return {
            role: "system",
            content: Locale.Store.Prompt.History(session.memoryPrompt),
            date: "",
          } as ChatMessage;
        }
      },

      async getMessagesWithMemory() {
        const session = get().currentSession();
        const modelConfig = session.mask.modelConfig;
        const clearContextIndex = session.clearContextIndex ?? 0;
        const messages = session.messages.slice();
        const totalMessageCount = session.messages.length;

        // in-context prompts
        const contextPrompts = session.mask.context.slice();

        // system prompts
        const isOpenAI =
          session.mask.modelConfig.model.startsWith("gpt-") ||
          session.mask.modelConfig.model.startsWith("chatgpt-");

        const mcpEnabled = await isMcpEnabled();
        const mcpSystemPrompt = mcpEnabled ? await getMcpSystemPrompt() : "";

        // Build system prompt content:
        // - OpenAI models: always include DEFAULT_SYSTEM_TEMPLATE
        // - All models: append user's systemPrompt when enableInjectSystemPrompts is on
        // - All models: append MCP prompt when MCP is enabled
        const systemParts: string[] = [];

        if (isOpenAI) {
          systemParts.push(
            fillTemplateWith("", {
              ...modelConfig,
              template: DEFAULT_SYSTEM_TEMPLATE,
            }),
          );
        }

        if (
          modelConfig.enableInjectSystemPrompts &&
          modelConfig.systemPrompt?.trim()
        ) {
          systemParts.push(modelConfig.systemPrompt.trim());
        }

        if (mcpSystemPrompt) {
          systemParts.push(mcpSystemPrompt);
        }

        if (modelConfig.enableTavily) {
          systemParts.push(TAVILY_SYSTEM_TEMPLATE);
        }

        var systemPrompts: ChatMessage[] = [];
        if (systemParts.length > 0) {
          systemPrompts = [
            createMessage({
              role: "system",
              content: systemParts.join("\n\n"),
            }),
          ];
        }

        if (systemPrompts.length > 0) {
          console.log(
            "[System Prompt] ",
            systemPrompts.at(0)?.content ?? "empty",
          );
        }
        const memoryPrompt = get().getMemoryPrompt();
        // long term memory
        const shouldSendLongTermMemory =
          modelConfig.sendMemory &&
          session.memoryPrompt &&
          session.memoryPrompt.length > 0 &&
          session.lastSummarizeIndex > clearContextIndex;
        const longTermMemoryPrompts =
          shouldSendLongTermMemory && memoryPrompt ? [memoryPrompt] : [];
        const longTermMemoryStartIndex = session.lastSummarizeIndex;

        // short term memory
        const shortTermMemoryStartIndex = Math.max(
          0,
          totalMessageCount - modelConfig.historyMessageCount,
        );

        // lets concat send messages, including 4 parts:
        // 0. system prompt: to get close to OpenAI Web ChatGPT
        // 1. long term memory: summarized memory messages
        // 2. pre-defined in-context prompts
        // 3. short term memory: latest n messages
        // 4. newest input message
        const memoryStartIndex = shouldSendLongTermMemory
          ? Math.min(longTermMemoryStartIndex, shortTermMemoryStartIndex)
          : shortTermMemoryStartIndex;
        // and if user has cleared history messages, we should exclude the memory too.
        const contextStartIndex = Math.max(clearContextIndex, memoryStartIndex);
        const maxTokenThreshold = modelConfig.max_tokens;

        // get recent messages as much as possible
        const reversedRecentMessages = [];
        for (
          let i = totalMessageCount - 1, tokenCount = 0;
          i >= contextStartIndex && tokenCount < maxTokenThreshold;
          i -= 1
        ) {
          const msg = messages[i];
          if (!msg || msg.isError) continue;
          tokenCount += estimateTokenLength(getMessageTextContent(msg));
          reversedRecentMessages.push(msg);
        }
        // concat all messages
        const recentMessages = [
          ...systemPrompts,
          ...longTermMemoryPrompts,
          ...contextPrompts,
          ...reversedRecentMessages.reverse(),
        ];

        // Process messages to inject memoryContext if available
        // and strip thinking content from assistant messages
        const finalMessages = stripThinkingFromMessages(recentMessages).map(
          (msg) => {
            if (msg.role === "user" && msg.memoryContext) {
              return {
                ...msg,
                content: `Context:\n${msg.memoryContext}\n\nQuestion:\n${msg.content}`,
              };
            }
            return msg;
          },
        );

        return finalMessages;
      },

      updateMessage(
        sessionIndex: number,
        messageIndex: number,
        updater: (message: ChatMessage) => ChatMessage,
      ) {
        set((state) => {
          const newSessions = state.sessions.map((session, sIndex) => {
            if (sIndex !== sessionIndex) {
              return session;
            }

            const newMessages = session.messages.map((message, mIndex) => {
              if (mIndex !== messageIndex) {
                return message;
              }
              return updater(message);
            });

            // Return a new session object with the new messages array
            return { ...session, messages: newMessages };
          });

          return { sessions: newSessions };
        });
      },

      resetSession(session: ChatSession) {
        get().updateTargetSession(session, (session) => {
          session.messages = [];
          session.memoryPrompt = "";
          session.lastArchivedContextId = undefined;
        });
      },

      summarizeSession(
        refreshTitle: boolean = false,
        targetSession: ChatSession,
      ) {
        const config = useAppConfig.getState();
        const session = targetSession;
        const modelConfig = session.mask.modelConfig;
        // skip summarize when using dalle3?
        if (isDalle3(modelConfig.model)) {
          return;
        }

        // if not config compressModel, then using getSummarizeModel
        const [model, providerName] = modelConfig.compressModel
          ? [modelConfig.compressModel, modelConfig.compressProviderName]
          : getSummarizeModel(
              session.mask.modelConfig.model,
              session.mask.modelConfig.providerName,
            );
        const api: ClientApi = getClientApi(providerName as ServiceProvider);

        // remove error messages if any
        const messages = session.messages;

        // should summarize topic after chating more than 50 words
        const SUMMARIZE_MIN_LEN = 50;
        if (
          (config.enableAutoGenerateTitle &&
            session.topic === DEFAULT_TOPIC &&
            countMessages(messages) >= SUMMARIZE_MIN_LEN) ||
          refreshTitle
        ) {
          const startIndex = Math.max(
            0,
            messages.length - modelConfig.historyMessageCount,
          );
          const topicMessages = stripThinkingFromMessages(
            messages.slice(
              startIndex < messages.length ? startIndex : messages.length - 1,
              messages.length,
            ),
          ).concat(
            createMessage({
              role: "user",
              content: Locale.Store.Prompt.Topic,
            }),
          );
          api.llm.chat({
            messages: topicMessages,
            config: {
              model,
              stream: false,
              providerName,
              useStandardCompletion: true,
              suppressReasoningOutput: true,
            },
            onFinish(message, responseRes) {
              if (responseRes?.status === 200) {
                get().updateTargetSession(
                  session,
                  (session) =>
                    (session.topic =
                      message.length > 0 ? trimTopic(message) : DEFAULT_TOPIC),
                );
              }
            },
          });
        }
        const summarizeIndex = Math.max(
          session.lastSummarizeIndex,
          session.clearContextIndex ?? 0,
        );
        let toBeSummarizedMsgs = messages
          .filter((msg) => !msg.isError)
          .slice(summarizeIndex);

        const historyMsgLength = countMessages(toBeSummarizedMsgs);

        if (historyMsgLength > (modelConfig?.max_tokens || 4000)) {
          const n = toBeSummarizedMsgs.length;
          toBeSummarizedMsgs = toBeSummarizedMsgs.slice(
            Math.max(0, n - modelConfig.historyMessageCount),
          );
        }
        const memoryPrompt = get().getMemoryPrompt();
        if (memoryPrompt) {
          // add memory prompt
          toBeSummarizedMsgs.unshift(memoryPrompt);
        }

        const lastSummarizeIndex = session.messages.length;

        console.log(
          "[Chat History] ",
          toBeSummarizedMsgs,
          historyMsgLength,
          modelConfig.compressMessageLengthThreshold,
        );

        if (
          historyMsgLength > modelConfig.compressMessageLengthThreshold &&
          modelConfig.sendMemory
        ) {
          /** Destruct max_tokens while summarizing
           * this param is just shit
           **/
          const { max_tokens, ...modelcfg } = modelConfig;
          const compressEffort = modelConfig.compressModel
            ? modelConfig.compressModelReasoningEffort
            : "";
          api.llm.chat({
            messages: stripThinkingFromMessages(toBeSummarizedMsgs).concat(
              createMessage({
                role: "system",
                content: Locale.Store.Prompt.Summarize,
                date: "",
              }),
            ),
            config: {
              ...modelcfg,
              stream: true,
              model,
              providerName,
              reasoningEffort: compressEffort,
              useStandardCompletion: true,
              suppressReasoningOutput: true,
            },
            onUpdate(message) {
              session.memoryPrompt = message;
            },
            onFinish(message, responseRes) {
              if (responseRes?.status === 200) {
                console.log("[Memory] ", message);
                get().updateTargetSession(session, (session) => {
                  session.lastSummarizeIndex = lastSummarizeIndex;
                  session.memoryPrompt = message; // Update the memory prompt for stored it in local storage
                });
              }
            },
            onError(err) {
              console.error("[Summarize] ", err);
            },
          });
        }
      },

      updateStat(message: ChatMessage, session: ChatSession) {
        get().updateTargetSession(session, (session) => {
          session.stat.charCount += message.content.length;
          // TODO: should update chat count and word count
        });
      },
      updateTargetSession(
        targetSession: ChatSession,
        updater: (session: ChatSession) => void,
      ) {
        const sessions = get().sessions;
        const index = sessions.findIndex((s) => s.id === targetSession.id);
        if (index < 0) return;
        updater(sessions[index]);
        set(() => ({ sessions }));
      },
      async clearAllData() {
        await indexedDBStorage.clear();
        localStorage.clear();
        location.reload();
      },
      setLastInput(lastInput: string) {
        set({
          lastInput,
        });
      },
      updateSessionDraft(sessionId: string, draft: string) {
        const sessions = get().sessions;
        const index = sessions.findIndex((s) => s.id === sessionId);
        if (index < 0) return;
        sessions[index].draftInput = draft;
        set(() => ({ sessions }));
      },

      /** check if the message contains MCP JSON and execute the MCP action */
      checkMcpJson(message: ChatMessage) {
        const mcpEnabled = isMcpEnabled();
        if (!mcpEnabled) return;
        const content = getMessageTextContent(message);
        if (isMcpJson(content)) {
          try {
            const mcpRequest = extractMcpJson(content);
            if (mcpRequest) {
              console.debug("[MCP Request]", mcpRequest);

              executeMcpAction(mcpRequest.clientId, mcpRequest.mcp)
                .then((result) => {
                  console.log("[MCP Response]", result);
                  const mcpResponse =
                    typeof result === "object"
                      ? JSON.stringify(result)
                      : String(result);
                  get().onUserInput(
                    `\`\`\`json:mcp-response:${mcpRequest.clientId}\n${mcpResponse}\n\`\`\``,
                    [],
                    true,
                  );
                })
                .catch((error) => showToast("MCP execution failed", error));
            }
          } catch (error) {
            console.error("[Check MCP JSON]", error);
          }
        }
      },
    };
    return methods;
  },
  {
    name: StoreKey.Chat,
    version: 3.8,
    partialize: (state) => partializeChatState(state) as any,

    merge: (persisted: any, current: any) => {
      if (!persisted) return current;
      const rev = persisted.rev || 0;
      const hasPersistedSessions =
        Array.isArray(persisted.sessions) && persisted.sessions.length > 0;
      const base = hasPersistedSessions
        ? { ...current, sessions: stripOnlyPlaceholder(current.sessions ?? []) }
        : current;

      const mergedState = reconcileChatStore(base, persisted);
      return {
        ...mergedState,
        _rev: rev,
      };
    },
    onRehydrateStorage: () => {
      return async (hydratedState: any, error) => {
        if (error) return;
        console.log("rev is:", hydratedState._rev);
        try {
          hydratedState.initCrossTabSync?.();
        } catch (e) {
          console.error(e);
        }

        // Restore per-tab session selection from sessionStorage
        const savedSessionId = getTabCurrentSessionId();
        if (savedSessionId && hydratedState.sessions) {
          const index = hydratedState.sessions.findIndex(
            (s: ChatSession) => s.id === savedSessionId,
          );
          if (index >= 0 && index !== hydratedState.currentSessionIndex) {
            // onRehydrateStorage is called after hydration completes,
            // so we can safely update state directly
            useChatStore.setState({ currentSessionIndex: index });
            console.log(
              "[Chat] Restored per-tab session selection:",
              savedSessionId,
            );
          }
        } else if (hydratedState.sessions?.length > 0) {
          // No saved session - save the current one for future refreshes
          setTabCurrentSessionId(
            hydratedState.sessions[hydratedState.currentSessionIndex || 0]?.id,
          );
        }
      };
    },
    migrate(persistedState, version) {
      const state = persistedState as any;
      const newState = JSON.parse(
        JSON.stringify(state),
      ) as typeof DEFAULT_CHAT_STATE;

      if (version < 2) {
        newState.sessions = [];

        const oldSessions = state.sessions;
        for (const oldSession of oldSessions) {
          const newSession = createEmptySession();
          newSession.topic = oldSession.topic;
          newSession.messages = [...oldSession.messages];
          newSession.mask.modelConfig.sendMemory = true;
          newSession.mask.modelConfig.historyMessageCount = 4;
          newSession.mask.modelConfig.compressMessageLengthThreshold = 1000;
          newState.sessions.push(newSession);
        }
      }

      if (version < 3) {
        // migrate id to nanoid
        newState.sessions.forEach((s) => {
          s.id = nanoid();
          s.messages.forEach((m) => (m.id = nanoid()));
        });
      }

      // Enable `enableInjectSystemPrompts` attribute for old sessions.
      // Resolve issue of old sessions not automatically enabling.
      if (version < 3.1) {
        newState.sessions.forEach((s) => {
          if (
            // Exclude those already set by user
            !s.mask.modelConfig.hasOwnProperty("enableInjectSystemPrompts")
          ) {
            // Because users may have changed this configuration,
            // the user's current configuration is used instead of the default
            const config = useAppConfig.getState();
            s.mask.modelConfig.enableInjectSystemPrompts =
              config.modelConfig.enableInjectSystemPrompts;
          }
        });
      }

      // add default summarize model for every session
      if (version < 3.2) {
        newState.sessions.forEach((s) => {
          const config = useAppConfig.getState();
          s.mask.modelConfig.compressModel = config.modelConfig.compressModel;
          s.mask.modelConfig.compressProviderName =
            config.modelConfig.compressProviderName;
        });
      }
      // revert default summarize model for every session
      if (version < 3.3) {
        newState.sessions.forEach((s) => {
          const config = useAppConfig.getState();
          s.mask.modelConfig.compressModel = "";
          s.mask.modelConfig.compressProviderName = "";
        });
      }
      if (version < 3.4) {
        newState.sessions.forEach((s) => {
          s.pinned = s.pinned ?? false; // Add pinned field, default to false

          if (s.pinned) {
            s.pinnedAt = s.pinnedAt ?? s.lastUpdate ?? Date.now();
          } else {
            s.pinnedAt = null;
          }
        });
        newState.isMenuOpen = newState.isMenuOpen ?? false;
        newState.menuPosition = newState.menuPosition ?? { top: 0, left: 0 };
        newState.menuSessionId = newState.menuSessionId ?? null;
        // Initial sort after migration
        const { sortedSessions, newIndex } = sortSessions(
          newState.sessions,
          newState.sessions[newState.currentSessionIndex]?.id,
        );
        newState.sessions = sortedSessions;
        newState.currentSessionIndex = newIndex;
      }

      if (version < 3.5) {
        newState.sessions.forEach((s) => {
          s.enableMemory = s.enableMemory ?? true;
          s.lastArchivedContextId = s.lastArchivedContextId ?? undefined;
          s.lastExtractionTime = s.lastExtractionTime ?? undefined;
        });
      }

      if (version < 3.6) {
        newState.sessions.forEach((s) => {
          s.deletedAt = s.deletedAt ?? undefined;
        });
      }

      if (version < 3.7) {
        newState.sessions.forEach((s) => {
          s.mask.modelConfig.systemPrompt =
            s.mask.modelConfig.systemPrompt ?? "";
        });
      }

      if (version < 3.8) {
        newState.sessions.forEach((s) => {
          s.draftInput = s.draftInput ?? "";
        });
      }

      return newState as any;
    },
  },
);
