import { useState, useEffect, useMemo, useRef } from "react";
import { preload } from "swr";

import styles from "./settings.module.scss";

import ResetIcon from "../icons/reload.svg";
import AddIcon from "../icons/add.svg";
import CloseIcon from "../icons/close.svg";
import CopyIcon from "../icons/copy.svg";
import ClearIcon from "../icons/clear.svg";
import CancelIcon from "../icons/cancel.svg";
import DeleteIcon from "../icons/delete.svg";
import LoadingIcon from "../icons/three-dots.svg";
import EditIcon from "../icons/edit.svg";
import FireIcon from "../icons/fire.svg";
import EyeIcon from "../icons/eye.svg";
import DownloadIcon from "../icons/download.svg";
import UploadIcon from "../icons/upload.svg";
import ConfigIcon from "../icons/config.svg";
import ConfirmIcon from "../icons/confirm.svg";

import ConnectionIcon from "../icons/connection.svg";
import CloudSuccessIcon from "../icons/cloud-success.svg";
import CloudFailIcon from "../icons/cloud-fail.svg";
import { trackSettingsPageGuideToCPaymentClick } from "../utils/auth-settings-events";
import {
  Input,
  List,
  ListItem,
  Modal,
  PasswordInput,
  Popover,
  Select,
  ChipInput,
  Toggle,
  Card,
  showConfirm,
  showPrompt,
  showToast,
} from "./ui-lib";
import { ModelConfigList } from "./model-config";
import { ModelSelect } from "./model-select";
import type { GroupedModels } from "./model-select";
import { getModelEffortLevels } from "../utils/model-utils";
import modelConfigStyles from "./model-config.module.scss";

import { IconButton } from "./button";
import {
  SubmitKey,
  useChatStore,
  Theme,
  useUpdateStore,
  useAccessStore,
  useAppConfig,
} from "../store";

import { useAllModels } from "../utils/hooks";
import { getModelProvider } from "../utils/model";
import { useMemoryStore } from "../store/memory";

import Locale, {
  AllLangs,
  ALL_LANG_OPTIONS,
  changeLang,
  getLang,
} from "../locales";
import { copyToClipboard, clientUpdate, semverCompare } from "../utils";
import Link from "next/link";
import {
  Anthropic,
  Azure,
  Baidu,
  Tencent,
  ByteDance,
  Alibaba,
  Moonshot,
  XAI,
  Google,
  GoogleSafetySettingsThreshold,
  OPENAI_BASE_URL,
  Path,
  RELEASE_URL,
  STORAGE_KEY,
  ServiceProvider,
  SlotID,
  UPDATE_URL,
  Stability,
  Iflytek,
  SAAS_CHAT_URL,
  ChatGLM,
  DeepSeek,
  SiliconFlow,
  AI302,
} from "../constant";
import { Prompt, SearchService, usePromptStore } from "../store/prompt";
import { ErrorBoundary } from "./error";
import { InputRange } from "./input-range";
import { useNavigate } from "react-router-dom";
import { Avatar, AvatarPicker } from "./emoji";
import { getClientConfig } from "../config/client";
import { useSyncStore } from "../store/sync";
import { nanoid } from "nanoid";
import { groupBy } from "lodash-es";
import { useMaskStore } from "../store/mask";
import { ProviderType } from "../utils/cloud";
import { TTSConfigList } from "./tts-config";
import { RealtimeConfigList } from "./realtime-chat/realtime-config";

function EditUserProfileModal(props: { onClose: () => void }) {
  const memoryStore = useMemoryStore();

  // STABLE STATE: using ID-based arrays to prevent focus issues when renaming
  type FieldType = "array" | "text" | "boolean";
  type Field = { id: string; key: string; value: any; fieldType: FieldType };
  type Domain = { id: string; name: string; fields: Field[] };

  // Helper to infer field type from existing value
  const inferFieldType = (value: any): FieldType => {
    if (Array.isArray(value)) return "array";
    if (typeof value === "boolean") return "boolean";
    return "text";
  };

  const [domains, setDomains] = useState<Domain[]>(() => {
    const raw = JSON.parse(JSON.stringify(memoryStore.content));
    const result: Domain[] = [];

    // 1. Handle existing data
    Object.entries(raw).forEach(([domainKey, domainValue]) => {
      // If it's a domain object (not an array)
      if (
        typeof domainValue === "object" &&
        domainValue !== null &&
        !Array.isArray(domainValue)
      ) {
        const fields: Field[] = Object.entries(domainValue).map(([k, v]) => ({
          id: nanoid(),
          key: k,
          value: v,
          fieldType: inferFieldType(v),
        }));
        result.push({ id: nanoid(), name: domainKey, fields });
      }
    });

    // 2. Handle flat data (migration) -> Put into "General" or create it if missing
    const flatFields: Field[] = [];
    Object.entries(raw).forEach(([k, v]) => {
      if (typeof v !== "object" || v === null || Array.isArray(v)) {
        flatFields.push({
          id: nanoid(),
          key: k,
          value: v,
          fieldType: inferFieldType(v),
        });
      }
    });

    if (flatFields.length > 0) {
      const general = result.find((d) => d.name === "General");
      if (general) {
        general.fields.push(...flatFields);
      } else {
        result.unshift({ id: nanoid(), name: "General", fields: flatFields });
      }
    }

    // Ensure at least one domain exists to start adding stuff if empty
    if (result.length === 0) {
      result.push({ id: nanoid(), name: "General", fields: [] });
    }

    return result;
  });

  // Track newly added field for auto-focus
  const [newFieldId, setNewFieldId] = useState<string | null>(null);
  // Refs for focus management
  const keyInputRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const chipInputRefs = useRef<Record<string, HTMLInputElement | null>>({});

  // Auto-focus key input when new field is added
  useEffect(() => {
    if (newFieldId && keyInputRefs.current[newFieldId]) {
      keyInputRefs.current[newFieldId]?.focus();
      keyInputRefs.current[newFieldId]?.select();
      setNewFieldId(null);
    }
  }, [newFieldId, domains]);

  const handleSave = () => {
    const content: Record<string, any> = {};
    domains.forEach((d) => {
      const domainContent: Record<string, any> = {};
      d.fields.forEach((f) => {
        if (f.key.trim()) {
          domainContent[f.key.trim()] = f.value;
        }
      });
      if (Object.keys(domainContent).length > 0 || d.name.trim()) {
        content[d.name.trim() || "Untitled"] = domainContent;
      }
    });
    memoryStore.updateContent(content);
    props.onClose();
  };

  // --- Actions ---

  const addDomain = () => {
    setDomains((prev) => [
      ...prev,
      { id: nanoid(), name: "New Section", fields: [] },
    ]);
  };

  const removeDomain = (id: string) => {
    setDomains((prev) => prev.filter((d) => d.id !== id));
  };

  const updateDomainName = (id: string, name: string) => {
    setDomains((prev) => prev.map((d) => (d.id === id ? { ...d, name } : d)));
  };

  const addField = (domainId: string) => {
    const fieldId = nanoid();
    setDomains((prev) =>
      prev.map((d) => {
        if (d.id === domainId) {
          return {
            ...d,
            fields: [
              ...d.fields,
              {
                id: fieldId,
                key: "",
                value: [],
                fieldType: "array" as FieldType,
              },
            ],
          };
        }
        return d;
      }),
    );
    setNewFieldId(fieldId);
  };

  const removeField = (domainId: string, fieldId: string) => {
    setDomains((prev) =>
      prev.map((d) => {
        if (d.id === domainId) {
          return { ...d, fields: d.fields.filter((f) => f.id !== fieldId) };
        }
        return d;
      }),
    );
  };

  const updateFieldKey = (domainId: string, fieldId: string, key: string) => {
    setDomains((prev) =>
      prev.map((d) => {
        if (d.id !== domainId) return d;
        return {
          ...d,
          fields: d.fields.map((f) => (f.id === fieldId ? { ...f, key } : f)),
        };
      }),
    );
  };

  const updateFieldValue = (domainId: string, fieldId: string, value: any) => {
    setDomains((prev) =>
      prev.map((d) => {
        if (d.id !== domainId) return d;
        return {
          ...d,
          fields: d.fields.map((f) => (f.id === fieldId ? { ...f, value } : f)),
        };
      }),
    );
  };

  const updateFieldType = (
    domainId: string,
    fieldId: string,
    newType: FieldType,
  ) => {
    setDomains((prev) =>
      prev.map((d) => {
        if (d.id !== domainId) return d;
        return {
          ...d,
          fields: d.fields.map((f) => {
            if (f.id !== fieldId) return f;
            // Convert value to match new type
            let newValue: any;
            if (newType === "array") {
              newValue = Array.isArray(f.value)
                ? f.value
                : f.value
                ? [String(f.value)]
                : [];
            } else if (newType === "boolean") {
              newValue = Boolean(f.value);
            } else {
              newValue = Array.isArray(f.value)
                ? f.value.join(", ")
                : String(f.value ?? "");
            }
            return { ...f, fieldType: newType, value: newValue };
          }),
        };
      }),
    );
  };

  const handleKeyInputKeyDown = (
    e: React.KeyboardEvent<HTMLInputElement>,
    fieldId: string,
  ) => {
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      // Focus the ChipInput for this field
      chipInputRefs.current[fieldId]?.focus();
    }
  };

  return (
    <div className="modal-mask">
      <Modal
        title={Locale.UserProfile.Edit}
        onClose={props.onClose}
        actions={[
          <IconButton
            key="cancel"
            text={Locale.UI.Cancel}
            onClick={props.onClose}
            bordered
            icon={<CancelIcon />}
          />,
          <IconButton
            key="confirm"
            text={Locale.UI.Confirm}
            type="primary"
            onClick={handleSave}
            bordered
            icon={<ConfirmIcon />}
          />,
        ]}
      >
        <div className={styles["user-profile-editor"]}>
          {domains.map((domain) => (
            <Card key={domain.id} className={styles["user-profile-card"]}>
              <div className={styles["user-profile-domain-header"]}>
                <div style={{ flexGrow: 1 }}>
                  <input
                    className={styles["user-profile-domain-title"]}
                    value={domain.name}
                    onChange={(e) =>
                      updateDomainName(domain.id, e.target.value)
                    }
                    placeholder="Domain Name"
                  />
                </div>
                <div className={styles["user-profile-actions"]}>
                  <IconButton
                    icon={<AddIcon />}
                    onClick={() => addField(domain.id)}
                    bordered
                    className={styles["mini-icon-button"]}
                    title="Add Facts"
                  />
                  <IconButton
                    icon={<DeleteIcon />}
                    onClick={() => removeDomain(domain.id)}
                    bordered
                    className={styles["mini-icon-button"]}
                    title="Delete Section"
                  />
                </div>
              </div>

              <div className={styles["user-profile-fields"]}>
                {domain.fields.map((field) => (
                  <div key={field.id} className={styles["user-profile-field"]}>
                    <div className={styles["user-profile-field-header"]}>
                      <input
                        ref={(el) => {
                          keyInputRefs.current[field.id] = el;
                        }}
                        className={styles["user-profile-field-label"]}
                        value={field.key}
                        onChange={(e) =>
                          updateFieldKey(domain.id, field.id, e.target.value)
                        }
                        onKeyDown={(e) => handleKeyInputKeyDown(e, field.id)}
                        placeholder="Fact Name"
                      />
                      <select
                        className={styles["user-profile-field-type"]}
                        value={field.fieldType}
                        onChange={(e) =>
                          updateFieldType(
                            domain.id,
                            field.id,
                            e.target.value as FieldType,
                          )
                        }
                      >
                        <option value="array">Tags</option>
                        <option value="text">Text</option>
                        <option value="boolean">Toggle</option>
                      </select>
                      <div
                        className={styles["user-profile-delete-field"]}
                        onClick={() => removeField(domain.id, field.id)}
                        title="Delete Field"
                      >
                        <DeleteIcon width={16} height={16} />
                      </div>
                    </div>

                    <div className={styles["user-profile-field-row"]}>
                      <div className={styles["user-profile-field-input"]}>
                        {field.fieldType === "array" ? (
                          <ChipInput
                            value={field.value}
                            onChange={(v) =>
                              updateFieldValue(domain.id, field.id, v)
                            }
                            inputRef={{
                              get current() {
                                return chipInputRefs.current[field.id];
                              },
                              set current(el) {
                                chipInputRefs.current[field.id] = el;
                              },
                            }}
                          />
                        ) : field.fieldType === "boolean" ? (
                          <Toggle
                            checked={field.value}
                            onChange={(v) =>
                              updateFieldValue(domain.id, field.id, v)
                            }
                          />
                        ) : (
                          <Input
                            value={field.value}
                            onChange={(e) =>
                              updateFieldValue(
                                domain.id,
                                field.id,
                                e.currentTarget.value,
                              )
                            }
                            rows={1}
                            autoHeight
                          />
                        )}
                      </div>
                      <div
                        className={styles["user-profile-delete-field"]}
                        onClick={() => removeField(domain.id, field.id)}
                        title="Delete Field"
                      >
                        <DeleteIcon width={16} height={16} />
                      </div>
                    </div>
                  </div>
                ))}
                {domain.fields.length === 0 && (
                  <div className={styles["empty-domain-hint"]}>
                    No facts yet. Click + to add one.
                  </div>
                )}
              </div>
            </Card>
          ))}

          <div className={styles["user-profile-footer"]}>
            <IconButton
              icon={<AddIcon />}
              text="Add New Section"
              onClick={addDomain}
              bordered
              className={styles["full-width-button"]}
            />
          </div>
        </div>
      </Modal>
    </div>
  );
}

function EditPromptModal(props: { id: string; onClose: () => void }) {
  const promptStore = usePromptStore();
  const prompt = promptStore.get(props.id);

  return prompt ? (
    <div className="modal-mask">
      <Modal
        title={Locale.Settings.Prompt.EditModal.Title}
        onClose={props.onClose}
        actions={[
          <IconButton
            key=""
            onClick={props.onClose}
            text={Locale.UI.Confirm}
            bordered
          />,
        ]}
      >
        <div className={styles["edit-prompt-modal"]}>
          <input
            type="text"
            value={prompt.title}
            readOnly={!prompt.isUser}
            className={styles["edit-prompt-title"]}
            onInput={(e) =>
              promptStore.updatePrompt(
                props.id,
                (prompt) => (prompt.title = e.currentTarget.value),
              )
            }
          ></input>
          <Input
            value={prompt.content}
            readOnly={!prompt.isUser}
            className={styles["edit-prompt-content"]}
            rows={10}
            onInput={(e) =>
              promptStore.updatePrompt(
                props.id,
                (prompt) => (prompt.content = e.currentTarget.value),
              )
            }
          ></Input>
        </div>
      </Modal>
    </div>
  ) : null;
}

function TavilyKeysModal(props: { onClose: () => void }) {
  const accessStore = useAccessStore();
  const raw = accessStore.tavilyApiKey;
  const [keys, setKeys] = useState<string[]>(() =>
    raw
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean),
  );

  const activeIndex = accessStore.activeTavilyKeyIndex ?? 0;

  const save = () => {
    const cleaned = keys.map((k) => k.trim()).filter(Boolean);
    accessStore.update((access) => {
      access.tavilyApiKey = cleaned.join(",");
      if (activeIndex >= cleaned.length) {
        access.activeTavilyKeyIndex = 0;
      }
    });
    props.onClose();
  };

  const updateKey = (index: number, value: string) => {
    setKeys((prev) => {
      const next = [...prev];
      next[index] = value;
      return next;
    });
  };

  const removeKey = (index: number) => {
    setKeys((prev) => prev.filter((_, i) => i !== index));
  };

  const addKey = () => {
    setKeys((prev) => [...prev, ""]);
  };

  return (
    <div className="modal-mask">
      <Modal
        title="Tavily API Keys"
        onClose={save}
        actions={[
          <IconButton
            key="add"
            icon={<AddIcon />}
            bordered
            text="Add Key"
            onClick={addKey}
          />,
          <IconButton
            key="save"
            icon={<ConfirmIcon />}
            bordered
            text="Save"
            type="primary"
            onClick={save}
          />,
        ]}
      >
        <div className={styles["tavily-keys-modal"]}>
          {keys.length === 0 ? (
            <div className={styles["tavily-keys-empty"]}>
              No API keys configured. Click &quot;Add Key&quot; to get started.
            </div>
          ) : (
            keys.map((key, i) => (
              <div key={i} className={styles["tavily-key-row"]}>
                <span className={styles["tavily-key-index"]}>{i + 1}</span>
                <span
                  className={`${styles["tavily-key-active-dot"]} ${
                    i === activeIndex && keys.filter((k) => k.trim()).length > 0
                      ? styles["active"]
                      : ""
                  }`}
                  title={i === activeIndex ? "Currently active key" : ""}
                />
                <div className={styles["tavily-key-input"]}>
                  <PasswordInput
                    aria-label={`Tavily API Key ${i + 1}`}
                    value={key}
                    type="text"
                    placeholder="tvly-..."
                    onChange={(e) => updateKey(i, e.currentTarget.value)}
                  />
                </div>
                <div
                  className={styles["tavily-key-delete"]}
                  onClick={() => removeKey(i)}
                  role="button"
                  tabIndex={0}
                  aria-label={`Delete key ${i + 1}`}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") removeKey(i);
                  }}
                >
                  <DeleteIcon />
                </div>
              </div>
            ))
          )}
        </div>
      </Modal>
    </div>
  );
}

function UserPromptModal(props: { onClose?: () => void }) {
  const promptStore = usePromptStore();
  const userPrompts = promptStore.getUserPrompts();
  const builtinPrompts = SearchService.builtinPrompts;
  const allPrompts = userPrompts.concat(builtinPrompts);
  const [searchInput, setSearchInput] = useState("");
  const [searchPrompts, setSearchPrompts] = useState<Prompt[]>([]);
  const prompts = searchInput.length > 0 ? searchPrompts : allPrompts;

  const [editingPromptId, setEditingPromptId] = useState<string>();

  useEffect(() => {
    if (searchInput.length > 0) {
      const searchResult = SearchService.search(searchInput);
      setSearchPrompts(searchResult);
    } else {
      setSearchPrompts([]);
    }
  }, [searchInput]);

  return (
    <div className="modal-mask">
      <Modal
        title={Locale.Settings.Prompt.Modal.Title}
        onClose={() => props.onClose?.()}
        actions={[
          <IconButton
            key="add"
            onClick={() => {
              const promptId = promptStore.add({
                id: nanoid(),
                createdAt: Date.now(),
                title: "Empty Prompt",
                content: "Empty Prompt Content",
              });
              setEditingPromptId(promptId);
            }}
            icon={<AddIcon />}
            bordered
            text={Locale.Settings.Prompt.Modal.Add}
          />,
        ]}
      >
        <div className={styles["user-prompt-modal"]}>
          <input
            type="text"
            className={styles["user-prompt-search"]}
            placeholder={Locale.Settings.Prompt.Modal.Search}
            value={searchInput}
            onInput={(e) => setSearchInput(e.currentTarget.value)}
          ></input>

          <div className={styles["user-prompt-list"]}>
            {prompts.map((v, _) => (
              <div className={styles["user-prompt-item"]} key={v.id ?? v.title}>
                <div className={styles["user-prompt-header"]}>
                  <div className={styles["user-prompt-title"]}>{v.title}</div>
                  <div className={styles["user-prompt-content"] + " one-line"}>
                    {v.content}
                  </div>
                </div>

                <div className={styles["user-prompt-buttons"]}>
                  {v.isUser && (
                    <IconButton
                      icon={<ClearIcon />}
                      className={styles["user-prompt-button"]}
                      onClick={() => promptStore.remove(v.id!)}
                    />
                  )}
                  {v.isUser ? (
                    <IconButton
                      icon={<EditIcon />}
                      className={styles["user-prompt-button"]}
                      onClick={() => setEditingPromptId(v.id)}
                    />
                  ) : (
                    <IconButton
                      icon={<EyeIcon />}
                      className={styles["user-prompt-button"]}
                      onClick={() => setEditingPromptId(v.id)}
                    />
                  )}
                  <IconButton
                    icon={<CopyIcon />}
                    className={styles["user-prompt-button"]}
                    onClick={() => copyToClipboard(v.content)}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      </Modal>

      {editingPromptId !== undefined && (
        <EditPromptModal
          id={editingPromptId!}
          onClose={() => setEditingPromptId(undefined)}
        />
      )}
    </div>
  );
}

function DangerItems() {
  const chatStore = useChatStore();
  const appConfig = useAppConfig();

  return (
    <List>
      <ListItem
        title={Locale.Settings.Danger.Reset.Title}
        subTitle={Locale.Settings.Danger.Reset.SubTitle}
      >
        <IconButton
          aria={Locale.Settings.Danger.Reset.Title}
          text={Locale.Settings.Danger.Reset.Action}
          onClick={async () => {
            if (await showConfirm(Locale.Settings.Danger.Reset.Confirm)) {
              appConfig.reset();
            }
          }}
          type="danger"
        />
      </ListItem>
      <ListItem
        title={Locale.Settings.Danger.Clear.Title}
        subTitle={Locale.Settings.Danger.Clear.SubTitle}
      >
        <IconButton
          aria={Locale.Settings.Danger.Clear.Title}
          text={Locale.Settings.Danger.Clear.Action}
          onClick={async () => {
            if (await showConfirm(Locale.Settings.Danger.Clear.Confirm)) {
              chatStore.clearAllData();
            }
          }}
          type="danger"
        />
      </ListItem>
    </List>
  );
}

function CheckButton() {
  const syncStore = useSyncStore();

  const couldCheck = useMemo(() => {
    return syncStore.cloudSync();
  }, [syncStore]);

  const [checkState, setCheckState] = useState<
    "none" | "checking" | "success" | "failed"
  >("none");

  async function check() {
    setCheckState("checking");
    const valid = await syncStore.check();
    setCheckState(valid ? "success" : "failed");
  }

  if (!couldCheck) return null;

  return (
    <IconButton
      text={Locale.Settings.Sync.Config.Modal.Check}
      bordered
      onClick={check}
      icon={
        checkState === "none" ? (
          <ConnectionIcon />
        ) : checkState === "checking" ? (
          <LoadingIcon />
        ) : checkState === "success" ? (
          <CloudSuccessIcon />
        ) : checkState === "failed" ? (
          <CloudFailIcon />
        ) : (
          <ConnectionIcon />
        )
      }
    ></IconButton>
  );
}

function SyncConfigModal(props: { onClose?: () => void }) {
  const syncStore = useSyncStore();

  return (
    <div className="modal-mask">
      <Modal
        title={Locale.Settings.Sync.Config.Modal.Title}
        onClose={() => props.onClose?.()}
        actions={[
          <CheckButton key="check" />,
          <IconButton
            key="confirm"
            onClick={props.onClose}
            icon={<ConfirmIcon />}
            bordered
            text={Locale.UI.Confirm}
          />,
        ]}
      >
        <List>
          <ListItem
            title={Locale.Settings.Sync.Config.SyncType.Title}
            subTitle={Locale.Settings.Sync.Config.SyncType.SubTitle}
          >
            <select
              value={syncStore.provider}
              onChange={(e) => {
                syncStore.update(
                  (config) =>
                    (config.provider = e.target.value as ProviderType),
                );
              }}
            >
              {Object.entries(ProviderType).map(([k, v]) => (
                <option value={v} key={k}>
                  {k}
                </option>
              ))}
            </select>
          </ListItem>

          <ListItem
            title={Locale.Settings.Sync.Config.Proxy.Title}
            subTitle={Locale.Settings.Sync.Config.Proxy.SubTitle}
          >
            <input
              type="checkbox"
              checked={syncStore.useProxy}
              onChange={(e) => {
                syncStore.update(
                  (config) => (config.useProxy = e.currentTarget.checked),
                );
              }}
            ></input>
          </ListItem>
          {syncStore.useProxy ? (
            <ListItem
              title={Locale.Settings.Sync.Config.ProxyUrl.Title}
              subTitle={Locale.Settings.Sync.Config.ProxyUrl.SubTitle}
            >
              <input
                type="text"
                value={syncStore.proxyUrl}
                onChange={(e) => {
                  syncStore.update(
                    (config) => (config.proxyUrl = e.currentTarget.value),
                  );
                }}
              ></input>
            </ListItem>
          ) : null}
        </List>

        {syncStore.provider === ProviderType.WebDAV && (
          <>
            <List>
              <ListItem title={Locale.Settings.Sync.Config.WebDav.Endpoint}>
                <input
                  type="text"
                  value={syncStore.webdav.endpoint}
                  onChange={(e) => {
                    syncStore.update(
                      (config) =>
                        (config.webdav.endpoint = e.currentTarget.value),
                    );
                  }}
                ></input>
              </ListItem>

              <ListItem title={Locale.Settings.Sync.Config.WebDav.UserName}>
                <input
                  type="text"
                  value={syncStore.webdav.username}
                  onChange={(e) => {
                    syncStore.update(
                      (config) =>
                        (config.webdav.username = e.currentTarget.value),
                    );
                  }}
                ></input>
              </ListItem>
              <ListItem title={Locale.Settings.Sync.Config.WebDav.Password}>
                <PasswordInput
                  value={syncStore.webdav.password}
                  onChange={(e) => {
                    syncStore.update(
                      (config) =>
                        (config.webdav.password = e.currentTarget.value),
                    );
                  }}
                ></PasswordInput>
              </ListItem>
            </List>
          </>
        )}

        {syncStore.provider === ProviderType.UpStash && (
          <List>
            <ListItem title={Locale.Settings.Sync.Config.UpStash.Endpoint}>
              <input
                type="text"
                value={syncStore.upstash.endpoint}
                onChange={(e) => {
                  syncStore.update(
                    (config) =>
                      (config.upstash.endpoint = e.currentTarget.value),
                  );
                }}
              ></input>
            </ListItem>

            <ListItem title={Locale.Settings.Sync.Config.UpStash.UserName}>
              <input
                type="text"
                value={syncStore.upstash.username}
                placeholder={STORAGE_KEY}
                onChange={(e) => {
                  syncStore.update(
                    (config) =>
                      (config.upstash.username = e.currentTarget.value),
                  );
                }}
              ></input>
            </ListItem>
            <ListItem title={Locale.Settings.Sync.Config.UpStash.Password}>
              <PasswordInput
                value={syncStore.upstash.apiKey}
                onChange={(e) => {
                  syncStore.update(
                    (config) => (config.upstash.apiKey = e.currentTarget.value),
                  );
                }}
              ></PasswordInput>
            </ListItem>
          </List>
        )}
      </Modal>
    </div>
  );
}

function SyncItems() {
  const syncStore = useSyncStore();
  const chatStore = useChatStore();
  const promptStore = usePromptStore();
  const maskStore = useMaskStore();
  const couldSync = useMemo(() => {
    return syncStore.cloudSync();
  }, [syncStore]);

  const [showSyncConfigModal, setShowSyncConfigModal] = useState(false);

  const stateOverview = useMemo(() => {
    const sessions = chatStore.sessions;
    const messageCount = sessions.reduce((p, c) => p + c.messages.length, 0);

    return {
      chat: sessions.length,
      message: messageCount,
      prompt: Object.keys(promptStore.prompts).length,
      mask: Object.keys(maskStore.masks).length,
    };
  }, [chatStore.sessions, maskStore.masks, promptStore.prompts]);

  return (
    <>
      <List>
        <ListItem
          title={Locale.Settings.Sync.CloudState}
          subTitle={
            syncStore.lastProvider
              ? `${new Date(syncStore.lastSyncTime).toLocaleString()} [${
                  syncStore.lastProvider
                }]`
              : Locale.Settings.Sync.NotSyncYet
          }
        >
          <div style={{ display: "flex" }}>
            <IconButton
              aria={Locale.Settings.Sync.CloudState + Locale.UI.Config}
              icon={<ConfigIcon />}
              text={Locale.UI.Config}
              onClick={() => {
                setShowSyncConfigModal(true);
              }}
            />
            {couldSync && (
              <IconButton
                icon={<ResetIcon />}
                text={Locale.UI.Sync}
                onClick={async () => {
                  try {
                    await syncStore.sync();
                    showToast(Locale.Settings.Sync.Success);
                  } catch (e) {
                    showToast(Locale.Settings.Sync.Fail);
                    console.error("[Sync]", e);
                  }
                }}
              />
            )}
          </div>
        </ListItem>

        <ListItem
          title={Locale.Settings.Sync.LocalState}
          subTitle={Locale.Settings.Sync.Overview(stateOverview)}
        >
          <div style={{ display: "flex" }}>
            <IconButton
              aria={Locale.Settings.Sync.LocalState + Locale.UI.Export}
              icon={<UploadIcon />}
              text={Locale.UI.Export}
              onClick={() => {
                syncStore.export();
              }}
            />
            <IconButton
              aria={Locale.Settings.Sync.LocalState + Locale.UI.Import}
              icon={<DownloadIcon />}
              text={Locale.UI.Import}
              onClick={() => {
                syncStore.import();
              }}
            />
          </div>
        </ListItem>
      </List>

      {showSyncConfigModal && (
        <SyncConfigModal onClose={() => setShowSyncConfigModal(false)} />
      )}
    </>
  );
}

export function Settings() {
  const navigate = useNavigate();
  const allModels = useAllModels();
  const groupModels = groupBy(
    allModels.filter((v) => v.available),
    "provider.providerName",
  ) as unknown as GroupedModels;
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const config = useAppConfig();
  const updateConfig = config.update;

  // Extract all memory store hook reads at the top to avoid conditional hook calls
  const memoryModel = useMemoryStore((state) => state.memoryModelConfig.model);
  const memoryProviderName = useMemoryStore(
    (state) => state.memoryModelConfig.providerName,
  );
  const memoryReasoningEffort = useMemoryStore(
    (state) => state.memoryModelConfig.reasoningEffort,
  );
  const memoryContextInjectionDisplay = useMemoryStore(
    (state) => state.enableContextInjectionDisplay,
  );

  const updateStore = useUpdateStore();
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const currentVersion = updateStore.formatVersion(updateStore.version);
  const remoteId = updateStore.formatVersion(updateStore.remoteVersion);
  const hasNewVersion = semverCompare(currentVersion, remoteId) === -1;
  const updateUrl = getClientConfig()?.isApp ? RELEASE_URL : UPDATE_URL;

  function checkUpdate(force = false) {
    setCheckingUpdate(true);
    updateStore.getLatestVersion(force).then(() => {
      setCheckingUpdate(false);
    });

    console.log("[Update] local version ", updateStore.version);
    console.log("[Update] remote version ", updateStore.remoteVersion);
  }

  const accessStore = useAccessStore();
  const shouldHideBalanceQuery = useMemo(() => {
    const isOpenAiUrl = accessStore.openaiUrl.includes(OPENAI_BASE_URL);

    return (
      accessStore.hideBalanceQuery ||
      isOpenAiUrl ||
      accessStore.provider === ServiceProvider.Azure
    );
  }, [
    accessStore.hideBalanceQuery,
    accessStore.openaiUrl,
    accessStore.provider,
  ]);

  const usage = {
    used: updateStore.used,
    subscription: updateStore.subscription,
  };
  const [loadingUsage, setLoadingUsage] = useState(false);
  function checkUsage(force = false) {
    if (shouldHideBalanceQuery) {
      return;
    }

    setLoadingUsage(true);
    updateStore.updateUsage(force).finally(() => {
      setLoadingUsage(false);
    });
  }

  const enabledAccessControl = useMemo(
    () => accessStore.enabledAccessControl(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const promptStore = usePromptStore();
  const builtinCount = SearchService.count.builtin;
  const customCount = promptStore.getUserPrompts().length ?? 0;
  const [shouldShowPromptModal, setShowPromptModal] = useState(false);
  const [shouldShowUserProfileModal, setShowUserProfileModal] = useState(false);
  const [shouldShowTavilyKeysModal, setShowTavilyKeysModal] = useState(false);

  const showUsage = accessStore.isAuthorized();
  useEffect(() => {
    // checks per minutes
    checkUpdate();
    showUsage && checkUsage();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const keydownEvent = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        navigate(Path.Home);
      }
    };
    if (clientConfig?.isApp) {
      // Force to set custom endpoint to true if it's app
      accessStore.update((state) => {
        state.useCustomConfig = true;
      });
    }
    document.addEventListener("keydown", keydownEvent);
    return () => {
      document.removeEventListener("keydown", keydownEvent);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const clientConfig = useMemo(() => getClientConfig(), []);
  const showAccessCode = enabledAccessControl && !clientConfig?.isApp;

  const accessCodeComponent = showAccessCode && (
    <ListItem
      title={Locale.Settings.Access.AccessCode.Title}
      subTitle={Locale.Settings.Access.AccessCode.SubTitle}
    >
      <PasswordInput
        value={accessStore.accessCode}
        type="text"
        placeholder={Locale.Settings.Access.AccessCode.Placeholder}
        onChange={(e) => {
          accessStore.update(
            (access) => (access.accessCode = e.currentTarget.value),
          );
        }}
      />
    </ListItem>
  );

  const saasStartComponent = (
    <ListItem
      className={styles["subtitle-button"]}
      title={
        Locale.Settings.Access.SaasStart.Title +
        `${Locale.Settings.Access.SaasStart.Label}`
      }
      subTitle={Locale.Settings.Access.SaasStart.SubTitle}
    >
      <IconButton
        aria={
          Locale.Settings.Access.SaasStart.Title +
          Locale.Settings.Access.SaasStart.ChatNow
        }
        icon={<FireIcon />}
        type={"primary"}
        text={Locale.Settings.Access.SaasStart.ChatNow}
        onClick={() => {
          trackSettingsPageGuideToCPaymentClick();
          window.location.href = SAAS_CHAT_URL;
        }}
      />
    </ListItem>
  );

  const useCustomConfigComponent = // Conditionally render the following ListItem based on clientConfig.isApp
    !clientConfig?.isApp && ( // only show if isApp is false
      <ListItem
        title={Locale.Settings.Access.CustomEndpoint.Title}
        subTitle={Locale.Settings.Access.CustomEndpoint.SubTitle}
      >
        <input
          aria-label={Locale.Settings.Access.CustomEndpoint.Title}
          type="checkbox"
          checked={accessStore.useCustomConfig}
          onChange={(e) =>
            accessStore.update(
              (access) => (access.useCustomConfig = e.currentTarget.checked),
            )
          }
        ></input>
      </ListItem>
    );

  const openAIConfigComponent = accessStore.provider ===
    ServiceProvider.OpenAI && (
    <>
      <ListItem
        title={Locale.Settings.Access.OpenAI.Endpoint.Title}
        subTitle={Locale.Settings.Access.OpenAI.Endpoint.SubTitle}
      >
        <input
          aria-label={Locale.Settings.Access.OpenAI.Endpoint.Title}
          type="text"
          value={accessStore.openaiUrl}
          placeholder={OPENAI_BASE_URL}
          onChange={(e) =>
            accessStore.update(
              (access) => (access.openaiUrl = e.currentTarget.value),
            )
          }
        ></input>
      </ListItem>
      <ListItem
        title={Locale.Settings.Access.OpenAI.ApiKey.Title}
        subTitle={Locale.Settings.Access.OpenAI.ApiKey.SubTitle}
      >
        <PasswordInput
          aria={Locale.Settings.ShowPassword}
          aria-label={Locale.Settings.Access.OpenAI.ApiKey.Title}
          value={accessStore.openaiApiKey}
          type="text"
          placeholder={Locale.Settings.Access.OpenAI.ApiKey.Placeholder}
          onChange={(e) => {
            accessStore.update(
              (access) => (access.openaiApiKey = e.currentTarget.value),
            );
          }}
        />
      </ListItem>
    </>
  );

  const azureConfigComponent = accessStore.provider ===
    ServiceProvider.Azure && (
    <>
      <ListItem
        title={Locale.Settings.Access.Azure.Endpoint.Title}
        subTitle={
          Locale.Settings.Access.Azure.Endpoint.SubTitle + Azure.ExampleEndpoint
        }
      >
        <input
          aria-label={Locale.Settings.Access.Azure.Endpoint.Title}
          type="text"
          value={accessStore.azureUrl}
          placeholder={Azure.ExampleEndpoint}
          onChange={(e) =>
            accessStore.update(
              (access) => (access.azureUrl = e.currentTarget.value),
            )
          }
        ></input>
      </ListItem>
      <ListItem
        title={Locale.Settings.Access.Azure.ApiKey.Title}
        subTitle={Locale.Settings.Access.Azure.ApiKey.SubTitle}
      >
        <PasswordInput
          aria-label={Locale.Settings.Access.Azure.ApiKey.Title}
          value={accessStore.azureApiKey}
          type="text"
          placeholder={Locale.Settings.Access.Azure.ApiKey.Placeholder}
          onChange={(e) => {
            accessStore.update(
              (access) => (access.azureApiKey = e.currentTarget.value),
            );
          }}
        />
      </ListItem>
      <ListItem
        title={Locale.Settings.Access.Azure.ApiVerion.Title}
        subTitle={Locale.Settings.Access.Azure.ApiVerion.SubTitle}
      >
        <input
          aria-label={Locale.Settings.Access.Azure.ApiVerion.Title}
          type="text"
          value={accessStore.azureApiVersion}
          placeholder="2023-08-01-preview"
          onChange={(e) =>
            accessStore.update(
              (access) => (access.azureApiVersion = e.currentTarget.value),
            )
          }
        ></input>
      </ListItem>
    </>
  );

  const googleConfigComponent = accessStore.provider ===
    ServiceProvider.Google && (
    <>
      <ListItem
        title={Locale.Settings.Access.Google.Endpoint.Title}
        subTitle={
          Locale.Settings.Access.Google.Endpoint.SubTitle +
          Google.ExampleEndpoint
        }
      >
        <input
          aria-label={Locale.Settings.Access.Google.Endpoint.Title}
          type="text"
          value={accessStore.googleUrl}
          placeholder={Google.ExampleEndpoint}
          onChange={(e) =>
            accessStore.update(
              (access) => (access.googleUrl = e.currentTarget.value),
            )
          }
        ></input>
      </ListItem>
      <ListItem
        title={Locale.Settings.Access.Google.ApiKey.Title}
        subTitle={Locale.Settings.Access.Google.ApiKey.SubTitle}
      >
        <PasswordInput
          aria-label={Locale.Settings.Access.Google.ApiKey.Title}
          value={accessStore.googleApiKey}
          type="text"
          placeholder={Locale.Settings.Access.Google.ApiKey.Placeholder}
          onChange={(e) => {
            accessStore.update(
              (access) => (access.googleApiKey = e.currentTarget.value),
            );
          }}
        />
      </ListItem>
      <ListItem
        title={Locale.Settings.Access.Google.ApiVersion.Title}
        subTitle={Locale.Settings.Access.Google.ApiVersion.SubTitle}
      >
        <input
          aria-label={Locale.Settings.Access.Google.ApiVersion.Title}
          type="text"
          value={accessStore.googleApiVersion}
          placeholder="2023-08-01-preview"
          onChange={(e) =>
            accessStore.update(
              (access) => (access.googleApiVersion = e.currentTarget.value),
            )
          }
        ></input>
      </ListItem>
      <ListItem
        title={Locale.Settings.Access.Google.GoogleSafetySettings.Title}
        subTitle={Locale.Settings.Access.Google.GoogleSafetySettings.SubTitle}
      >
        <Select
          aria-label={Locale.Settings.Access.Google.GoogleSafetySettings.Title}
          value={accessStore.googleSafetySettings}
          onChange={(e) => {
            accessStore.update(
              (access) =>
                (access.googleSafetySettings = e.target
                  .value as GoogleSafetySettingsThreshold),
            );
          }}
        >
          {Object.entries(GoogleSafetySettingsThreshold).map(([k, v]) => (
            <option value={v} key={k}>
              {k}
            </option>
          ))}
        </Select>
      </ListItem>
    </>
  );

  const anthropicConfigComponent = accessStore.provider ===
    ServiceProvider.Anthropic && (
    <>
      <ListItem
        title={Locale.Settings.Access.Anthropic.Endpoint.Title}
        subTitle={
          Locale.Settings.Access.Anthropic.Endpoint.SubTitle +
          Anthropic.ExampleEndpoint
        }
      >
        <input
          aria-label={Locale.Settings.Access.Anthropic.Endpoint.Title}
          type="text"
          value={accessStore.anthropicUrl}
          placeholder={Anthropic.ExampleEndpoint}
          onChange={(e) =>
            accessStore.update(
              (access) => (access.anthropicUrl = e.currentTarget.value),
            )
          }
        ></input>
      </ListItem>
      <ListItem
        title={Locale.Settings.Access.Anthropic.ApiKey.Title}
        subTitle={Locale.Settings.Access.Anthropic.ApiKey.SubTitle}
      >
        <PasswordInput
          aria-label={Locale.Settings.Access.Anthropic.ApiKey.Title}
          value={accessStore.anthropicApiKey}
          type="text"
          placeholder={Locale.Settings.Access.Anthropic.ApiKey.Placeholder}
          onChange={(e) => {
            accessStore.update(
              (access) => (access.anthropicApiKey = e.currentTarget.value),
            );
          }}
        />
      </ListItem>
      <ListItem
        title={Locale.Settings.Access.Anthropic.ApiVerion.Title}
        subTitle={Locale.Settings.Access.Anthropic.ApiVerion.SubTitle}
      >
        <input
          aria-label={Locale.Settings.Access.Anthropic.ApiVerion.Title}
          type="text"
          value={accessStore.anthropicApiVersion}
          placeholder={Anthropic.Vision}
          onChange={(e) =>
            accessStore.update(
              (access) => (access.anthropicApiVersion = e.currentTarget.value),
            )
          }
        ></input>
      </ListItem>
    </>
  );

  const baiduConfigComponent = accessStore.provider ===
    ServiceProvider.Baidu && (
    <>
      <ListItem
        title={Locale.Settings.Access.Baidu.Endpoint.Title}
        subTitle={Locale.Settings.Access.Baidu.Endpoint.SubTitle}
      >
        <input
          aria-label={Locale.Settings.Access.Baidu.Endpoint.Title}
          type="text"
          value={accessStore.baiduUrl}
          placeholder={Baidu.ExampleEndpoint}
          onChange={(e) =>
            accessStore.update(
              (access) => (access.baiduUrl = e.currentTarget.value),
            )
          }
        ></input>
      </ListItem>
      <ListItem
        title={Locale.Settings.Access.Baidu.ApiKey.Title}
        subTitle={Locale.Settings.Access.Baidu.ApiKey.SubTitle}
      >
        <PasswordInput
          aria-label={Locale.Settings.Access.Baidu.ApiKey.Title}
          value={accessStore.baiduApiKey}
          type="text"
          placeholder={Locale.Settings.Access.Baidu.ApiKey.Placeholder}
          onChange={(e) => {
            accessStore.update(
              (access) => (access.baiduApiKey = e.currentTarget.value),
            );
          }}
        />
      </ListItem>
      <ListItem
        title={Locale.Settings.Access.Baidu.SecretKey.Title}
        subTitle={Locale.Settings.Access.Baidu.SecretKey.SubTitle}
      >
        <PasswordInput
          aria-label={Locale.Settings.Access.Baidu.SecretKey.Title}
          value={accessStore.baiduSecretKey}
          type="text"
          placeholder={Locale.Settings.Access.Baidu.SecretKey.Placeholder}
          onChange={(e) => {
            accessStore.update(
              (access) => (access.baiduSecretKey = e.currentTarget.value),
            );
          }}
        />
      </ListItem>
    </>
  );

  const tencentConfigComponent = accessStore.provider ===
    ServiceProvider.Tencent && (
    <>
      <ListItem
        title={Locale.Settings.Access.Tencent.Endpoint.Title}
        subTitle={Locale.Settings.Access.Tencent.Endpoint.SubTitle}
      >
        <input
          aria-label={Locale.Settings.Access.Tencent.Endpoint.Title}
          type="text"
          value={accessStore.tencentUrl}
          placeholder={Tencent.ExampleEndpoint}
          onChange={(e) =>
            accessStore.update(
              (access) => (access.tencentUrl = e.currentTarget.value),
            )
          }
        ></input>
      </ListItem>
      <ListItem
        title={Locale.Settings.Access.Tencent.ApiKey.Title}
        subTitle={Locale.Settings.Access.Tencent.ApiKey.SubTitle}
      >
        <PasswordInput
          aria-label={Locale.Settings.Access.Tencent.ApiKey.Title}
          value={accessStore.tencentSecretId}
          type="text"
          placeholder={Locale.Settings.Access.Tencent.ApiKey.Placeholder}
          onChange={(e) => {
            accessStore.update(
              (access) => (access.tencentSecretId = e.currentTarget.value),
            );
          }}
        />
      </ListItem>
      <ListItem
        title={Locale.Settings.Access.Tencent.SecretKey.Title}
        subTitle={Locale.Settings.Access.Tencent.SecretKey.SubTitle}
      >
        <PasswordInput
          aria-label={Locale.Settings.Access.Tencent.SecretKey.Title}
          value={accessStore.tencentSecretKey}
          type="text"
          placeholder={Locale.Settings.Access.Tencent.SecretKey.Placeholder}
          onChange={(e) => {
            accessStore.update(
              (access) => (access.tencentSecretKey = e.currentTarget.value),
            );
          }}
        />
      </ListItem>
    </>
  );

  const byteDanceConfigComponent = accessStore.provider ===
    ServiceProvider.ByteDance && (
    <>
      <ListItem
        title={Locale.Settings.Access.ByteDance.Endpoint.Title}
        subTitle={
          Locale.Settings.Access.ByteDance.Endpoint.SubTitle +
          ByteDance.ExampleEndpoint
        }
      >
        <input
          aria-label={Locale.Settings.Access.ByteDance.Endpoint.Title}
          type="text"
          value={accessStore.bytedanceUrl}
          placeholder={ByteDance.ExampleEndpoint}
          onChange={(e) =>
            accessStore.update(
              (access) => (access.bytedanceUrl = e.currentTarget.value),
            )
          }
        ></input>
      </ListItem>
      <ListItem
        title={Locale.Settings.Access.ByteDance.ApiKey.Title}
        subTitle={Locale.Settings.Access.ByteDance.ApiKey.SubTitle}
      >
        <PasswordInput
          aria-label={Locale.Settings.Access.ByteDance.ApiKey.Title}
          value={accessStore.bytedanceApiKey}
          type="text"
          placeholder={Locale.Settings.Access.ByteDance.ApiKey.Placeholder}
          onChange={(e) => {
            accessStore.update(
              (access) => (access.bytedanceApiKey = e.currentTarget.value),
            );
          }}
        />
      </ListItem>
    </>
  );

  const alibabaConfigComponent = accessStore.provider ===
    ServiceProvider.Alibaba && (
    <>
      <ListItem
        title={Locale.Settings.Access.Alibaba.Endpoint.Title}
        subTitle={
          Locale.Settings.Access.Alibaba.Endpoint.SubTitle +
          Alibaba.ExampleEndpoint
        }
      >
        <input
          aria-label={Locale.Settings.Access.Alibaba.Endpoint.Title}
          type="text"
          value={accessStore.alibabaUrl}
          placeholder={Alibaba.ExampleEndpoint}
          onChange={(e) =>
            accessStore.update(
              (access) => (access.alibabaUrl = e.currentTarget.value),
            )
          }
        ></input>
      </ListItem>
      <ListItem
        title={Locale.Settings.Access.Alibaba.ApiKey.Title}
        subTitle={Locale.Settings.Access.Alibaba.ApiKey.SubTitle}
      >
        <PasswordInput
          aria-label={Locale.Settings.Access.Alibaba.ApiKey.Title}
          value={accessStore.alibabaApiKey}
          type="text"
          placeholder={Locale.Settings.Access.Alibaba.ApiKey.Placeholder}
          onChange={(e) => {
            accessStore.update(
              (access) => (access.alibabaApiKey = e.currentTarget.value),
            );
          }}
        />
      </ListItem>
    </>
  );

  const moonshotConfigComponent = accessStore.provider ===
    ServiceProvider.Moonshot && (
    <>
      <ListItem
        title={Locale.Settings.Access.Moonshot.Endpoint.Title}
        subTitle={
          Locale.Settings.Access.Moonshot.Endpoint.SubTitle +
          Moonshot.ExampleEndpoint
        }
      >
        <input
          aria-label={Locale.Settings.Access.Moonshot.Endpoint.Title}
          type="text"
          value={accessStore.moonshotUrl}
          placeholder={Moonshot.ExampleEndpoint}
          onChange={(e) =>
            accessStore.update(
              (access) => (access.moonshotUrl = e.currentTarget.value),
            )
          }
        ></input>
      </ListItem>
      <ListItem
        title={Locale.Settings.Access.Moonshot.ApiKey.Title}
        subTitle={Locale.Settings.Access.Moonshot.ApiKey.SubTitle}
      >
        <PasswordInput
          aria-label={Locale.Settings.Access.Moonshot.ApiKey.Title}
          value={accessStore.moonshotApiKey}
          type="text"
          placeholder={Locale.Settings.Access.Moonshot.ApiKey.Placeholder}
          onChange={(e) => {
            accessStore.update(
              (access) => (access.moonshotApiKey = e.currentTarget.value),
            );
          }}
        />
      </ListItem>
    </>
  );

  const deepseekConfigComponent = accessStore.provider ===
    ServiceProvider.DeepSeek && (
    <>
      <ListItem
        title={Locale.Settings.Access.DeepSeek.Endpoint.Title}
        subTitle={
          Locale.Settings.Access.DeepSeek.Endpoint.SubTitle +
          DeepSeek.ExampleEndpoint
        }
      >
        <input
          aria-label={Locale.Settings.Access.DeepSeek.Endpoint.Title}
          type="text"
          value={accessStore.deepseekUrl}
          placeholder={DeepSeek.ExampleEndpoint}
          onChange={(e) =>
            accessStore.update(
              (access) => (access.deepseekUrl = e.currentTarget.value),
            )
          }
        ></input>
      </ListItem>
      <ListItem
        title={Locale.Settings.Access.DeepSeek.ApiKey.Title}
        subTitle={Locale.Settings.Access.DeepSeek.ApiKey.SubTitle}
      >
        <PasswordInput
          aria-label={Locale.Settings.Access.DeepSeek.ApiKey.Title}
          value={accessStore.deepseekApiKey}
          type="text"
          placeholder={Locale.Settings.Access.DeepSeek.ApiKey.Placeholder}
          onChange={(e) => {
            accessStore.update(
              (access) => (access.deepseekApiKey = e.currentTarget.value),
            );
          }}
        />
      </ListItem>
    </>
  );

  const XAIConfigComponent = accessStore.provider === ServiceProvider.XAI && (
    <>
      <ListItem
        title={Locale.Settings.Access.XAI.Endpoint.Title}
        subTitle={
          Locale.Settings.Access.XAI.Endpoint.SubTitle + XAI.ExampleEndpoint
        }
      >
        <input
          aria-label={Locale.Settings.Access.XAI.Endpoint.Title}
          type="text"
          value={accessStore.xaiUrl}
          placeholder={XAI.ExampleEndpoint}
          onChange={(e) =>
            accessStore.update(
              (access) => (access.xaiUrl = e.currentTarget.value),
            )
          }
        ></input>
      </ListItem>
      <ListItem
        title={Locale.Settings.Access.XAI.ApiKey.Title}
        subTitle={Locale.Settings.Access.XAI.ApiKey.SubTitle}
      >
        <PasswordInput
          aria-label={Locale.Settings.Access.XAI.ApiKey.Title}
          value={accessStore.xaiApiKey}
          type="text"
          placeholder={Locale.Settings.Access.XAI.ApiKey.Placeholder}
          onChange={(e) => {
            accessStore.update(
              (access) => (access.xaiApiKey = e.currentTarget.value),
            );
          }}
        />
      </ListItem>
    </>
  );

  const chatglmConfigComponent = accessStore.provider ===
    ServiceProvider.ChatGLM && (
    <>
      <ListItem
        title={Locale.Settings.Access.ChatGLM.Endpoint.Title}
        subTitle={
          Locale.Settings.Access.ChatGLM.Endpoint.SubTitle +
          ChatGLM.ExampleEndpoint
        }
      >
        <input
          aria-label={Locale.Settings.Access.ChatGLM.Endpoint.Title}
          type="text"
          value={accessStore.chatglmUrl}
          placeholder={ChatGLM.ExampleEndpoint}
          onChange={(e) =>
            accessStore.update(
              (access) => (access.chatglmUrl = e.currentTarget.value),
            )
          }
        ></input>
      </ListItem>
      <ListItem
        title={Locale.Settings.Access.ChatGLM.ApiKey.Title}
        subTitle={Locale.Settings.Access.ChatGLM.ApiKey.SubTitle}
      >
        <PasswordInput
          aria-label={Locale.Settings.Access.ChatGLM.ApiKey.Title}
          value={accessStore.chatglmApiKey}
          type="text"
          placeholder={Locale.Settings.Access.ChatGLM.ApiKey.Placeholder}
          onChange={(e) => {
            accessStore.update(
              (access) => (access.chatglmApiKey = e.currentTarget.value),
            );
          }}
        />
      </ListItem>
    </>
  );
  const siliconflowConfigComponent = accessStore.provider ===
    ServiceProvider.SiliconFlow && (
    <>
      <ListItem
        title={Locale.Settings.Access.SiliconFlow.Endpoint.Title}
        subTitle={
          Locale.Settings.Access.SiliconFlow.Endpoint.SubTitle +
          SiliconFlow.ExampleEndpoint
        }
      >
        <input
          aria-label={Locale.Settings.Access.SiliconFlow.Endpoint.Title}
          type="text"
          value={accessStore.siliconflowUrl}
          placeholder={SiliconFlow.ExampleEndpoint}
          onChange={(e) =>
            accessStore.update(
              (access) => (access.siliconflowUrl = e.currentTarget.value),
            )
          }
        ></input>
      </ListItem>
      <ListItem
        title={Locale.Settings.Access.SiliconFlow.ApiKey.Title}
        subTitle={Locale.Settings.Access.SiliconFlow.ApiKey.SubTitle}
      >
        <PasswordInput
          aria-label={Locale.Settings.Access.SiliconFlow.ApiKey.Title}
          value={accessStore.siliconflowApiKey}
          type="text"
          placeholder={Locale.Settings.Access.SiliconFlow.ApiKey.Placeholder}
          onChange={(e) => {
            accessStore.update(
              (access) => (access.siliconflowApiKey = e.currentTarget.value),
            );
          }}
        />
      </ListItem>
    </>
  );

  const stabilityConfigComponent = accessStore.provider ===
    ServiceProvider.Stability && (
    <>
      <ListItem
        title={Locale.Settings.Access.Stability.Endpoint.Title}
        subTitle={
          Locale.Settings.Access.Stability.Endpoint.SubTitle +
          Stability.ExampleEndpoint
        }
      >
        <input
          aria-label={Locale.Settings.Access.Stability.Endpoint.Title}
          type="text"
          value={accessStore.stabilityUrl}
          placeholder={Stability.ExampleEndpoint}
          onChange={(e) =>
            accessStore.update(
              (access) => (access.stabilityUrl = e.currentTarget.value),
            )
          }
        ></input>
      </ListItem>
      <ListItem
        title={Locale.Settings.Access.Stability.ApiKey.Title}
        subTitle={Locale.Settings.Access.Stability.ApiKey.SubTitle}
      >
        <PasswordInput
          aria-label={Locale.Settings.Access.Stability.ApiKey.Title}
          value={accessStore.stabilityApiKey}
          type="text"
          placeholder={Locale.Settings.Access.Stability.ApiKey.Placeholder}
          onChange={(e) => {
            accessStore.update(
              (access) => (access.stabilityApiKey = e.currentTarget.value),
            );
          }}
        />
      </ListItem>
    </>
  );
  const lflytekConfigComponent = accessStore.provider ===
    ServiceProvider.Iflytek && (
    <>
      <ListItem
        title={Locale.Settings.Access.Iflytek.Endpoint.Title}
        subTitle={
          Locale.Settings.Access.Iflytek.Endpoint.SubTitle +
          Iflytek.ExampleEndpoint
        }
      >
        <input
          aria-label={Locale.Settings.Access.Iflytek.Endpoint.Title}
          type="text"
          value={accessStore.iflytekUrl}
          placeholder={Iflytek.ExampleEndpoint}
          onChange={(e) =>
            accessStore.update(
              (access) => (access.iflytekUrl = e.currentTarget.value),
            )
          }
        ></input>
      </ListItem>
      <ListItem
        title={Locale.Settings.Access.Iflytek.ApiKey.Title}
        subTitle={Locale.Settings.Access.Iflytek.ApiKey.SubTitle}
      >
        <PasswordInput
          aria-label={Locale.Settings.Access.Iflytek.ApiKey.Title}
          value={accessStore.iflytekApiKey}
          type="text"
          placeholder={Locale.Settings.Access.Iflytek.ApiKey.Placeholder}
          onChange={(e) => {
            accessStore.update(
              (access) => (access.iflytekApiKey = e.currentTarget.value),
            );
          }}
        />
      </ListItem>

      <ListItem
        title={Locale.Settings.Access.Iflytek.ApiSecret.Title}
        subTitle={Locale.Settings.Access.Iflytek.ApiSecret.SubTitle}
      >
        <PasswordInput
          aria-label={Locale.Settings.Access.Iflytek.ApiSecret.Title}
          value={accessStore.iflytekApiSecret}
          type="text"
          placeholder={Locale.Settings.Access.Iflytek.ApiSecret.Placeholder}
          onChange={(e) => {
            accessStore.update(
              (access) => (access.iflytekApiSecret = e.currentTarget.value),
            );
          }}
        />
      </ListItem>
    </>
  );

  const ai302ConfigComponent = accessStore.provider ===
    ServiceProvider["302.AI"] && (
    <>
      <ListItem
        title={Locale.Settings.Access.AI302.Endpoint.Title}
        subTitle={
          Locale.Settings.Access.AI302.Endpoint.SubTitle + AI302.ExampleEndpoint
        }
      >
        <input
          aria-label={Locale.Settings.Access.AI302.Endpoint.Title}
          type="text"
          value={accessStore.ai302Url}
          placeholder={AI302.ExampleEndpoint}
          onChange={(e) =>
            accessStore.update(
              (access) => (access.ai302Url = e.currentTarget.value),
            )
          }
        ></input>
      </ListItem>
      <ListItem
        title={Locale.Settings.Access.AI302.ApiKey.Title}
        subTitle={Locale.Settings.Access.AI302.ApiKey.SubTitle}
      >
        <PasswordInput
          aria-label={Locale.Settings.Access.AI302.ApiKey.Title}
          value={accessStore.ai302ApiKey}
          type="text"
          placeholder={Locale.Settings.Access.AI302.ApiKey.Placeholder}
          onChange={(e) => {
            accessStore.update(
              (access) => (access.ai302ApiKey = e.currentTarget.value),
            );
          }}
        />
      </ListItem>
    </>
  );

  return (
    <ErrorBoundary>
      <div className="window-header" data-tauri-drag-region>
        <div className="window-header-title">
          <div className="window-header-main-title">
            {Locale.Settings.Title}
          </div>
          <div className="window-header-sub-title">
            {Locale.Settings.SubTitle}
          </div>
        </div>
        <div className="window-actions">
          <div className="window-action-button"></div>
          <div className="window-action-button"></div>
          <div className="window-action-button">
            <IconButton
              aria={Locale.UI.Close}
              icon={<CloseIcon />}
              onClick={() => navigate(Path.Home)}
              bordered
            />
          </div>
        </div>
      </div>
      <div className={styles["settings"]}>
        <List>
          <ListItem title={Locale.Settings.Avatar}>
            <Popover
              onClose={() => setShowEmojiPicker(false)}
              content={
                <AvatarPicker
                  onEmojiClick={(avatar: string) => {
                    updateConfig((config) => (config.avatar = avatar));
                    setShowEmojiPicker(false);
                  }}
                />
              }
              open={showEmojiPicker}
            >
              <div
                aria-label={Locale.Settings.Avatar}
                tabIndex={0}
                className={styles.avatar}
                onClick={() => {
                  setShowEmojiPicker(!showEmojiPicker);
                }}
              >
                <Avatar avatar={config.avatar} />
              </div>
            </Popover>
          </ListItem>

          <ListItem
            title={Locale.Settings.Update.Version(currentVersion ?? "unknown")}
            subTitle={
              checkingUpdate
                ? Locale.Settings.Update.IsChecking
                : hasNewVersion
                ? Locale.Settings.Update.FoundUpdate(remoteId ?? "ERROR")
                : Locale.Settings.Update.IsLatest
            }
          >
            {checkingUpdate ? (
              <LoadingIcon />
            ) : hasNewVersion ? (
              clientConfig?.isApp ? (
                <IconButton
                  icon={<ResetIcon></ResetIcon>}
                  text={Locale.Settings.Update.GoToUpdate}
                  onClick={() => clientUpdate()}
                />
              ) : (
                <Link href={updateUrl} target="_blank" className="link">
                  {Locale.Settings.Update.GoToUpdate}
                </Link>
              )
            ) : (
              <IconButton
                icon={<ResetIcon></ResetIcon>}
                text={Locale.Settings.Update.CheckUpdate}
                onClick={() => checkUpdate(true)}
              />
            )}
          </ListItem>

          <ListItem title={Locale.Settings.SendKey}>
            <Select
              aria-label={Locale.Settings.SendKey}
              value={config.submitKey}
              onChange={(e) => {
                updateConfig(
                  (config) =>
                    (config.submitKey = e.target.value as any as SubmitKey),
                );
              }}
            >
              {Object.values(SubmitKey).map((v) => (
                <option value={v} key={v}>
                  {v}
                </option>
              ))}
            </Select>
          </ListItem>

          <ListItem title={Locale.Settings.Theme}>
            <Select
              aria-label={Locale.Settings.Theme}
              value={config.theme}
              onChange={(e) => {
                updateConfig(
                  (config) => (config.theme = e.target.value as any as Theme),
                );
              }}
            >
              {Object.values(Theme).map((v) => (
                <option value={v} key={v}>
                  {v}
                </option>
              ))}
            </Select>
          </ListItem>

          <ListItem title={Locale.Settings.Lang.Name}>
            <Select
              aria-label={Locale.Settings.Lang.Name}
              value={getLang()}
              onChange={(e) => {
                changeLang(e.target.value as any);
              }}
            >
              {AllLangs.map((lang) => (
                <option value={lang} key={lang}>
                  {ALL_LANG_OPTIONS[lang]}
                </option>
              ))}
            </Select>
          </ListItem>

          <ListItem
            title={Locale.Settings.FontSize.Title}
            subTitle={Locale.Settings.FontSize.SubTitle}
          >
            <InputRange
              aria={Locale.Settings.FontSize.Title}
              title={`${config.fontSize ?? 14}px`}
              value={config.fontSize}
              min="12"
              max="40"
              step="1"
              onChange={(e) =>
                updateConfig(
                  (config) =>
                    (config.fontSize = Number.parseInt(e.currentTarget.value)),
                )
              }
            ></InputRange>
          </ListItem>

          <ListItem
            title={Locale.Settings.FontFamily.Title}
            subTitle={Locale.Settings.FontFamily.SubTitle}
          >
            <input
              aria-label={Locale.Settings.FontFamily.Title}
              type="text"
              value={config.fontFamily}
              placeholder={Locale.Settings.FontFamily.Placeholder}
              onChange={(e) =>
                updateConfig(
                  (config) => (config.fontFamily = e.currentTarget.value),
                )
              }
            ></input>
          </ListItem>

          <ListItem
            title={Locale.Settings.AutoGenerateTitle.Title}
            subTitle={Locale.Settings.AutoGenerateTitle.SubTitle}
          >
            <input
              aria-label={Locale.Settings.AutoGenerateTitle.Title}
              type="checkbox"
              checked={config.enableAutoGenerateTitle}
              onChange={(e) =>
                updateConfig(
                  (config) =>
                    (config.enableAutoGenerateTitle = e.currentTarget.checked),
                )
              }
            ></input>
          </ListItem>

          <ListItem
            title={Locale.Settings.SendPreviewBubble.Title}
            subTitle={Locale.Settings.SendPreviewBubble.SubTitle}
          >
            <input
              aria-label={Locale.Settings.SendPreviewBubble.Title}
              type="checkbox"
              checked={config.sendPreviewBubble}
              onChange={(e) =>
                updateConfig(
                  (config) =>
                    (config.sendPreviewBubble = e.currentTarget.checked),
                )
              }
            ></input>
          </ListItem>

          <ListItem
            title={Locale.Mask.Config.Artifacts.Title}
            subTitle={Locale.Mask.Config.Artifacts.SubTitle}
          >
            <input
              aria-label={Locale.Mask.Config.Artifacts.Title}
              type="checkbox"
              checked={config.enableArtifacts}
              onChange={(e) =>
                updateConfig(
                  (config) =>
                    (config.enableArtifacts = e.currentTarget.checked),
                )
              }
            ></input>
          </ListItem>
          <ListItem
            title={Locale.Mask.Config.CodeFold.Title}
            subTitle={Locale.Mask.Config.CodeFold.SubTitle}
          >
            <input
              aria-label={Locale.Mask.Config.CodeFold.Title}
              type="checkbox"
              checked={config.enableCodeFold}
              data-testid="enable-code-fold-checkbox"
              onChange={(e) =>
                updateConfig(
                  (config) => (config.enableCodeFold = e.currentTarget.checked),
                )
              }
            ></input>
          </ListItem>
        </List>

        <SyncItems />

        <List>
          <ListItem
            title={Locale.Settings.Mask.Splash.Title}
            subTitle={Locale.Settings.Mask.Splash.SubTitle}
          >
            <input
              aria-label={Locale.Settings.Mask.Splash.Title}
              type="checkbox"
              checked={!config.dontShowMaskSplashScreen}
              onChange={(e) =>
                updateConfig(
                  (config) =>
                    (config.dontShowMaskSplashScreen =
                      !e.currentTarget.checked),
                )
              }
            ></input>
          </ListItem>

          <ListItem
            title={Locale.Settings.Mask.Builtin.Title}
            subTitle={Locale.Settings.Mask.Builtin.SubTitle}
          >
            <input
              aria-label={Locale.Settings.Mask.Builtin.Title}
              type="checkbox"
              checked={config.hideBuiltinMasks}
              onChange={(e) =>
                updateConfig(
                  (config) =>
                    (config.hideBuiltinMasks = e.currentTarget.checked),
                )
              }
            ></input>
          </ListItem>
        </List>

        <List>
          <ListItem
            title={Locale.Settings.Prompt.Disable.Title}
            subTitle={Locale.Settings.Prompt.Disable.SubTitle}
          >
            <input
              aria-label={Locale.Settings.Prompt.Disable.Title}
              type="checkbox"
              checked={config.disablePromptHint}
              onChange={(e) =>
                updateConfig(
                  (config) =>
                    (config.disablePromptHint = e.currentTarget.checked),
                )
              }
            ></input>
          </ListItem>

          <ListItem
            title={Locale.Settings.Prompt.List}
            subTitle={Locale.Settings.Prompt.ListCount(
              builtinCount,
              customCount,
            )}
          >
            <IconButton
              aria={Locale.Settings.Prompt.List + Locale.Settings.Prompt.Edit}
              icon={<EditIcon />}
              text={Locale.Settings.Prompt.Edit}
              onClick={() => setShowPromptModal(true)}
            />
          </ListItem>
        </List>

        <List id={SlotID.CustomModel}>
          {saasStartComponent}
          {accessCodeComponent}

          {!accessStore.hideUserApiKey && (
            <>
              {useCustomConfigComponent}

              {accessStore.useCustomConfig && (
                <>
                  <ListItem
                    title={Locale.Settings.Access.Provider.Title}
                    subTitle={Locale.Settings.Access.Provider.SubTitle}
                  >
                    <Select
                      aria-label={Locale.Settings.Access.Provider.Title}
                      value={accessStore.provider}
                      onChange={(e) => {
                        accessStore.update(
                          (access) =>
                            (access.provider = e.target
                              .value as ServiceProvider),
                        );
                      }}
                    >
                      {Object.entries(ServiceProvider).map(([k, v]) => (
                        <option value={v} key={k}>
                          {k}
                        </option>
                      ))}
                    </Select>
                  </ListItem>

                  {openAIConfigComponent}
                  {azureConfigComponent}
                  {googleConfigComponent}
                  {anthropicConfigComponent}
                  {baiduConfigComponent}
                  {byteDanceConfigComponent}
                  {alibabaConfigComponent}
                  {tencentConfigComponent}
                  {moonshotConfigComponent}
                  {deepseekConfigComponent}
                  {stabilityConfigComponent}
                  {lflytekConfigComponent}
                  {XAIConfigComponent}
                  {chatglmConfigComponent}
                  {siliconflowConfigComponent}
                  {ai302ConfigComponent}
                </>
              )}
            </>
          )}

          {!shouldHideBalanceQuery && !clientConfig?.isApp ? (
            <ListItem
              title={Locale.Settings.Usage.Title}
              subTitle={
                showUsage
                  ? loadingUsage
                    ? Locale.Settings.Usage.IsChecking
                    : Locale.Settings.Usage.SubTitle(
                        usage?.used ?? "[?]",
                        usage?.subscription ?? "[?]",
                      )
                  : Locale.Settings.Usage.NoAccess
              }
            >
              {!showUsage || loadingUsage ? (
                <div />
              ) : (
                <IconButton
                  icon={<ResetIcon></ResetIcon>}
                  text={Locale.Settings.Usage.Check}
                  onClick={() => checkUsage(true)}
                />
              )}
            </ListItem>
          ) : null}

          <ListItem
            title={Locale.Settings.Access.CustomModel.Title}
            subTitle={Locale.Settings.Access.CustomModel.SubTitle}
            vertical={true}
          >
            <input
              aria-label={Locale.Settings.Access.CustomModel.Title}
              style={{ width: "100%", maxWidth: "unset", textAlign: "left" }}
              type="text"
              value={config.customModels}
              placeholder="model1,model2,model3"
              onChange={(e) =>
                config.update(
                  (config) => (config.customModels = e.currentTarget.value),
                )
              }
            ></input>
          </ListItem>
        </List>

        <List>
          <ModelConfigList
            modelConfig={config.modelConfig}
            updateConfig={(updater) => {
              const modelConfig = { ...config.modelConfig };
              updater(modelConfig);
              config.update((config) => (config.modelConfig = modelConfig));
            }}
          />
        </List>

        <List>
          <ListItem
            title={Locale.UserProfile.Enable}
            subTitle={Locale.UserProfile.EnableSubTitle}
          >
            <input
              aria-label={Locale.UserProfile.Enable}
              type="checkbox"
              checked={config.modelConfig.enableMemory}
              onChange={(e) =>
                config.update(
                  (c) => (c.modelConfig.enableMemory = e.currentTarget.checked),
                )
              }
            ></input>
          </ListItem>
          <ListItem
            title={Locale.UserProfile.Profile}
            subTitle={Locale.UserProfile.ProfileSubTitle}
          >
            <IconButton
              icon={<EditIcon />}
              text={Locale.UserProfile.Edit}
              onClick={() => setShowUserProfileModal(true)}
            />
          </ListItem>
          {shouldShowUserProfileModal && (
            <EditUserProfileModal
              onClose={() => setShowUserProfileModal(false)}
            />
          )}
          <ListItem
            title={Locale.UserProfile.Model}
            subTitle={Locale.UserProfile.ModelSubTitle}
          >
            <div className={modelConfigStyles["model-effort-row"]}>
              <ModelSelect
                aria-label={Locale.UserProfile.Model}
                value={`${memoryModel}@${memoryProviderName}`}
                models={groupModels}
                onChange={(val) => {
                  const [model, providerName] = getModelProvider(val);
                  useMemoryStore
                    .getState()
                    .updateMemoryModelConfig((config) => {
                      config.model = model;
                      config.providerName = providerName as ServiceProvider;
                      config.reasoningEffort = "";
                    });
                }}
              />
              {getModelEffortLevels(memoryModel) && (
                <>
                  <select
                    aria-label={Locale.Settings.ReasoningEffort.Title}
                    className={modelConfigStyles["effort-select"]}
                    value={memoryReasoningEffort || ""}
                    onChange={(e) => {
                      useMemoryStore
                        .getState()
                        .updateMemoryModelConfig((config) => {
                          config.reasoningEffort = e.target.value;
                        });
                    }}
                  >
                    <option value="">Default (highest)</option>
                    {getModelEffortLevels(memoryModel)?.map((level) => (
                      <option key={level} value={level}>
                        {level}
                      </option>
                    ))}
                  </select>
                  <span className={modelConfigStyles["effort-info"]}>
                    <button
                      type="button"
                      className={modelConfigStyles["effort-info-btn"]}
                      aria-label={Locale.Settings.ReasoningEffort.SubTitle}
                      tabIndex={0}
                    >
                      i
                    </button>
                    <span
                      className={modelConfigStyles["effort-tooltip"]}
                      role="tooltip"
                    >
                      {Locale.Settings.ReasoningEffort.SubTitle}
                    </span>
                  </span>
                </>
              )}
            </div>
          </ListItem>
          <ListItem
            title={Locale.UserProfile.InjectionDisplay.Title}
            subTitle={Locale.UserProfile.InjectionDisplay.SubTitle}
          >
            <input
              aria-label={Locale.UserProfile.InjectionDisplay.Title}
              type="checkbox"
              checked={memoryContextInjectionDisplay}
              onChange={(e) =>
                useMemoryStore
                  .getState()
                  .setEnableContextInjectionDisplay(e.currentTarget.checked)
              }
            ></input>
          </ListItem>
          <ListItem
            title={Locale.UserProfile.VectorDebug.Title}
            subTitle={Locale.UserProfile.VectorDebug.SubTitle}
          >
            <IconButton
              icon={<EyeIcon />}
              onMouseEnter={() => {
                preload("/api/vector/debug?limit=20&offset=0", (url: string) =>
                  fetch(url).then((res) => res.json()),
                );
              }}
              onClick={() => {
                navigate(Path.VectorDebug);
              }}
            />
          </ListItem>
        </List>

        <List>
          <ListItem
            title="Enable Tavily Search"
            subTitle="Allow the model to autonomously search the web for real-time information"
          >
            <input
              aria-label="Enable Tavily Search"
              type="checkbox"
              checked={config.modelConfig.enableTavily}
              onChange={(e) =>
                config.update(
                  (config) =>
                    (config.modelConfig.enableTavily = e.currentTarget.checked),
                )
              }
            ></input>
          </ListItem>
          <ListItem
            title="Tavily API Keys"
            subTitle={(() => {
              const keyCount = accessStore.tavilyApiKey
                .split(",")
                .map((k) => k.trim())
                .filter(Boolean).length;
              if (keyCount === 0) return "No keys configured";
              const activeIdx = (accessStore.activeTavilyKeyIndex ?? 0) + 1;
              return `${keyCount} key${keyCount > 1 ? "s" : ""} configured${
                keyCount > 1 ? ` (Key ${activeIdx} active)` : ""
              }`;
            })()}
          >
            <IconButton
              icon={<EditIcon />}
              text="Manage Keys"
              onClick={() => setShowTavilyKeysModal(true)}
            />
          </ListItem>
          {shouldShowTavilyKeysModal && (
            <TavilyKeysModal onClose={() => setShowTavilyKeysModal(false)} />
          )}
          <ListItem
            title="Tavily Search Type"
            subTitle="Choose between Basic, Advanced, or Extract mode"
          >
            <Select
              aria-label="Tavily Search Type"
              value={config.modelConfig.tavilySearchType}
              onChange={(e) => {
                config.update(
                  (config) =>
                    (config.modelConfig.tavilySearchType = e.target
                      .value as any),
                );
              }}
            >
              <option value="basic">Basic Search</option>
              <option value="advanced">Advanced Search</option>
              <option value="extract">Extract API</option>
            </Select>
          </ListItem>
          <ListItem
            title="Tavily Max Results"
            subTitle="Maximum number of search results to fetch per query"
          >
            <InputRange
              aria="Tavily Max Results"
              title={`${config.modelConfig.tavilyMaxResults}`}
              value={config.modelConfig.tavilyMaxResults}
              min="1"
              max="20"
              step="1"
              onChange={(e) => {
                config.update(
                  (config) =>
                    (config.modelConfig.tavilyMaxResults =
                      parseInt(e.currentTarget.value) || 5),
                );
              }}
            />
          </ListItem>
          <ListItem
            title="Max Chunks Per Source"
            subTitle="Maximum chunk depth when including raw content"
          >
            <InputRange
              aria="Max Chunks Per Source"
              title={`${config.modelConfig.tavilyMaxChunksPerSource}`}
              value={config.modelConfig.tavilyMaxChunksPerSource}
              min="1"
              max="20"
              step="1"
              onChange={(e) => {
                config.update(
                  (config) =>
                    (config.modelConfig.tavilyMaxChunksPerSource =
                      parseInt(e.currentTarget.value) || 5),
                );
              }}
            />
          </ListItem>
        </List>

        {shouldShowPromptModal && (
          <UserPromptModal onClose={() => setShowPromptModal(false)} />
        )}
        <List>
          <RealtimeConfigList
            realtimeConfig={config.realtimeConfig}
            updateConfig={(updater) => {
              const realtimeConfig = { ...config.realtimeConfig };
              updater(realtimeConfig);
              config.update(
                (config) => (config.realtimeConfig = realtimeConfig),
              );
            }}
          />
        </List>
        <List>
          <TTSConfigList
            ttsConfig={config.ttsConfig}
            updateConfig={(updater) => {
              const ttsConfig = { ...config.ttsConfig };
              updater(ttsConfig);
              config.update((config) => (config.ttsConfig = ttsConfig));
            }}
          />
        </List>

        <DangerItems />
      </div>
    </ErrorBoundary>
  );
}
