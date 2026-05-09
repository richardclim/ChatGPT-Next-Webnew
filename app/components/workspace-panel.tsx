import React, { useEffect, useState, useMemo } from "react";
import styles from "./workspace-panel.module.scss";
import { useWorkspaceStore } from "../store/workspace";
import { useChatStore } from "../store/chat";
import { IconButton } from "./button";

import LoadingIcon from "../icons/three-dots.svg";
import SyncIcon from "../icons/reload.svg";
import {
  PencilSimpleIcon,
  DownloadSimpleIcon,
  LinkBreakIcon,
  EyeSlashIcon,
} from "@phosphor-icons/react";
import { Markdown } from "./markdown";
import { showPrompt } from "./ui-lib";
import { useDebouncedCallback } from "use-debounce";

type SyncStatus = "synced" | "unsynced" | "error" | "syncing";

export function WorkspacePanel(props: {
  workspaceId: string;
  sessionId: string;
  onClose: () => void;
  onDetach: () => void;
}) {
  const workspaceStore = useWorkspaceStore();
  const workspace = workspaceStore.workspaces[props.workspaceId];
  const [localContent, setLocalContent] = useState("");
  const [isEditing, setIsEditing] = useState(false);

  useEffect(() => {
    if (workspace && !workspace.isSyncing) {
      setLocalContent(workspace.content);
    }
  }, [workspace?.content, workspace?.isSyncing]);

  // Derive sync status from workspace + session state
  const syncStatus: SyncStatus = useMemo(() => {
    if (!workspace) return "synced";
    if (workspace.isSyncing) return "syncing";
    if (workspace.lastSyncError) return "error";

    const chatStore = useChatStore.getState();
    const session = chatStore.sessions.find((s) => s.id === props.sessionId);
    if (!session || session.messages.length === 0) return "synced";

    if (!session.lastWorkspaceSyncMessageId) return "unsynced";

    const lastMessage = session.messages[session.messages.length - 1];
    return session.lastWorkspaceSyncMessageId === lastMessage.id
      ? "synced"
      : "unsynced";
  }, [
    workspace?.isSyncing,
    workspace?.lastSyncError,
    workspace?.lastSyncedTimestamp,
    props.sessionId,
  ]);

  const handleSync = () => {
    workspaceStore.syncWorkspaceContext(workspace.id, props.sessionId);
  };

  const handleRename = async () => {
    const newTitle = await showPrompt("Enter new workspace title", workspace.title);
    if (newTitle) {
      workspaceStore.updateWorkspaceTitle(workspace.id, newTitle);
    }
  };

  const debouncedUpdateContent = useDebouncedCallback((content: string) => {
    workspaceStore.updateWorkspaceContent(workspace.id, content, false);
  }, 1000);

  useEffect(() => {
    return () => {
      debouncedUpdateContent.flush();
    };
  }, [debouncedUpdateContent]);

  const handleContentChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setLocalContent(e.target.value);
    debouncedUpdateContent(e.target.value);
  };

  if (!workspace) return null;

  const handleDownload = () => {
    const blob = new Blob([workspace.content], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${workspace.title.replace(/\\s+/g, "_")}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const syncTooltip = (() => {
    switch (syncStatus) {
      case "syncing": return "Syncing...";
      case "synced": return "Notes are up to date.\nAuto-syncs when switching sessions.";
      case "error": return `Sync failed: ${workspace.lastSyncError}\nClick to retry.`;
      default: return "Sync notes with latest chat messages.\nAuto-syncs when switching sessions.";
    }
  })();

  const linkedCount = workspace.linkedSessions.length;

  return (
    <div className={styles["workspace-panel"]}>
      <div className={styles["workspace-header"]}>
        <div className={styles["workspace-title-box"]}>
          <div className={styles["workspace-title"]} onClick={handleRename} style={{ cursor: "pointer", display: "flex", alignItems: "center", gap: "6px" }}>
            {workspace.title} <PencilSimpleIcon size={14} />
          </div>
          <div className={styles["workspace-subtext"]}>
            {linkedCount > 0
              ? `${linkedCount} Linked Session${linkedCount > 1 ? "s" : ""}`
              : "No linked sessions yet"}
          </div>
        </div>

        <div className={styles["workspace-actions"]}>
          <IconButton
            icon={<PencilSimpleIcon weight={isEditing ? "fill" : "regular"} />}
            onClick={() => setIsEditing(!isEditing)}
            title={isEditing ? "Switch to Preview" : "Edit Markdown"}
          />
          <div className={styles["sync-button-wrapper"]} title={syncTooltip}>
            <span
              className={`${styles["sync-dot"]} ${styles[`sync-dot--${syncStatus}`]}`}
            />
            <IconButton
              icon={workspace.isSyncing ? <LoadingIcon /> : <SyncIcon />}
              onClick={handleSync}
              disabled={workspace.isSyncing}
              title={syncTooltip}
            />
          </div>
          <IconButton icon={<DownloadSimpleIcon />} onClick={handleDownload} title="Download as Markdown" />
          <IconButton icon={<LinkBreakIcon />} onClick={props.onDetach} title="Detach Workspace" />
          <IconButton icon={<EyeSlashIcon />} onClick={props.onClose} title="Hide Panel" />
        </div>
      </div>

      <div className={styles["workspace-body"]}>
        {workspace.isSyncing ? (
          <div className={styles["workspace-lock-overlay"]}>
            <LoadingIcon />
            <div>Applying Latest Updates...</div>
          </div>
        ) : null}

        {!isEditing ? (
          <div className={styles["workspace-preview"]} onDoubleClick={() => setIsEditing(true)}>
            <Markdown content={localContent || "Start typing your research notes here..."} />
          </div>
        ) : (
          <textarea
            className={styles["workspace-editor"]}
            value={localContent}
            onChange={handleContentChange}
            onBlur={() => debouncedUpdateContent.flush()}
            placeholder="Start typing your research notes here..."
            disabled={workspace.isSyncing}
            autoFocus
          />
        )}
      </div>
    </div>
  );
}
