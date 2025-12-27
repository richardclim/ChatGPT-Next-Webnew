import KebabMenuIcon from "../icons/kebab-menu.svg";
import { IconButton } from "./button";
import React, { useState, useEffect, useRef, useTransition, memo } from "react";
import { shallow } from "zustand/shallow";
import styles from "./home.module.scss";
import {
  DragDropContext,
  Droppable,
  Draggable,
  OnDragEndResponder,
} from "@hello-pangea/dnd";

import { useVirtualizer } from "@tanstack/react-virtual";
import { useChatStore, useProfileStore } from "../store";
import Locale from "../locales";
import { useLocation, useNavigate } from "react-router-dom";
import { Path } from "../constant";
import { MaskAvatar } from "./mask";
import { Mask } from "../store/mask";
import { showConfirm } from "./ui-lib";
import { useMobileScreen } from "../utils";
import clsx from "clsx";
import PinIcon from "../icons/pin.svg";

interface ChatItemProps {
  onClick?: () => void;
  onDelete?: () => void;
  title: string;
  count: number;
  time: string;
  selected: boolean;
  id: string;
  index: number;
  narrow?: boolean;
  mask: Mask;
  style?: React.CSSProperties;
  isPinned: boolean;
}

const ChatItem = memo(function ChatItem({
  onClick,
  onDelete,
  title,
  count,
  time,
  selected,
  id,
  index,
  narrow,
  mask,
  style,
  isPinned,
}: ChatItemProps) {
  const draggableRef = useRef<HTMLDivElement | null>(null);
  const [isHovered, setIsHovered] = useState(false);

  const { openMenu, closeMenu } = useChatStore(
    (state) => ({
      openMenu: state.openMenu,
      closeMenu: state.closeMenu,
    }),
    shallow,
  );
  const isMenuOpen = useChatStore(
    (state) => state.isMenuOpen && state.menuSessionId === id,
  );
  const [isAnimatingPin, setIsAnimatingPin] = useState(false);
  const [isAnimatingUnpin, setIsAnimatingUnpin] = useState(false);
  const prevPinnedStatusRef = useRef(isPinned);

  useEffect(() => {
    if (selected && draggableRef.current) {
      draggableRef.current?.scrollIntoView({
        block: "center",
      });
    }
  }, [selected]);

  useEffect(() => {
    const currentPinnedStatus = isPinned;
    if (prevPinnedStatusRef.current === true && currentPinnedStatus === false) {
      // Was pinned, now unpinned
      setIsAnimatingUnpin(true);
      setTimeout(() => setIsAnimatingUnpin(false), 500);
    } else if (
      prevPinnedStatusRef.current === false &&
      currentPinnedStatus === true
    ) {
      setIsAnimatingPin(true);
      setTimeout(() => setIsAnimatingPin(false), 500);
    }
    prevPinnedStatusRef.current = currentPinnedStatus;
  }, [isPinned]);

  const { pathname: currentPath } = useLocation();
  return (
    <Draggable draggableId={`${id}`} index={index}>
      {(provided) => (
        <div
          className={clsx(styles["chat-item"], {
            [styles["chat-item-selected"]]:
              selected &&
              (currentPath === Path.Chat || currentPath === Path.Home),
            [styles["chat-item-pinned"]]: isPinned,
            [styles["chat-item-animating-pin"]]: isAnimatingPin,
            [styles["chat-item-animating-unpin"]]: isAnimatingUnpin,
          })}
          onClick={onClick}
          onMouseEnter={() => setIsHovered(true)}
          onMouseLeave={() => setIsHovered(false)}
          ref={(ele) => {
            draggableRef.current = ele;
            provided.innerRef(ele);
          }}
          {...provided.draggableProps}
          {...provided.dragHandleProps}
          style={{
            ...provided.draggableProps.style,
            ...style,
          }}
          title={`${title}\n${Locale.ChatItem.ChatItemCount(count)}`}
        >
          {!narrow && (
            <div
              className={styles["chat-item-menu-icon-container"]}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                if (isMenuOpen) {
                  closeMenu();
                } else {
                  const rect = e.currentTarget.getBoundingClientRect();
                  openMenu(id, {
                    top: rect.top - 21,
                    left: rect.left + 33,
                  });
                }
              }}
            >
              <IconButton
                icon={isHovered || !isPinned ? <KebabMenuIcon /> : <PinIcon />}
                shadow
                title={Locale.ChatItem.MoreOptions}
                className={styles["menu-icon-button"]}
              />
            </div>
          )}
          {narrow ? (
            <div className={styles["chat-item-narrow"]}>
              <div className={clsx(styles["chat-item-avatar"], "no-dark")}>
                <MaskAvatar
                  avatar={mask.avatar}
                  model={mask.modelConfig.model}
                />
              </div>
              <div className={styles["chat-item-narrow-count"]}>{count}</div>
            </div>
          ) : (
            <>
              <div className={styles["chat-item-title"]}>{title}</div>
              <div className={styles["chat-item-info"]}>
                <div className={styles["chat-item-count"]}>
                  {Locale.ChatItem.ChatItemCount(count)}
                </div>
                <div className={styles["chat-item-date"]}>{time}</div>
              </div>
            </>
          )}
          {/* The old delete icon is removed from here */}
        </div>
      )}
    </Draggable>
  );
});

function ChatListSkeleton({ narrow }: { narrow?: boolean }) {
  return (
    <div className={styles["chat-list"]}>
      {Array.from({ length: 35 }).map((_, i) => (
        <div key={i} className={clsx(styles["chat-item"], styles["skeleton"])}>
          {narrow ? (
            <div
              className={clsx(
                styles["chat-item-narrow"],
                styles["chat-item-narrow-skeleton"],
              )}
            >
              <div
                className={clsx(
                  styles["chat-item-avatar"],
                  styles["skeleton-avatar"],
                )}
              ></div>
            </div>
          ) : (
            <>
              <div
                className={clsx(
                  styles["chat-item-title"],
                  styles["skeleton-title"],
                )}
              ></div>
              <div
                className={clsx(
                  styles["chat-item-info"],
                  styles["skeleton-info"],
                )}
              ></div>
            </>
          )}
        </div>
      ))}
    </div>
  );
}

export function ChatList({
  narrow,
  scrollRef,
}: {
  narrow?: boolean;
  scrollRef: React.RefObject<HTMLDivElement>;
}) {
  const { sessions, selectedIndex, selectSession, moveSession, hasHydrated } =
    useChatStore(
      (state) => ({
        sessions: state.sessions,
        selectedIndex: state.currentSessionIndex,
        selectSession: state.selectSession,
        moveSession: state.moveSession,
        hasHydrated: state._hasHydrated,
      }),
      shallow,
    );
  const chatStore = useChatStore();
  const profileStore = useProfileStore();
  const navigate = useNavigate();
  const isMobileScreen = useMobileScreen();
  const [isPending, startTransition] = useTransition();
  const [displayedSessions, setDisplayedSessions] = useState(sessions);
  const dndContainerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    startTransition(() => {
      const { currentProfileId } = profileStore;
      const filteredSessions = sessions.filter((s) => {
        if (!currentProfileId) {
          // If no profile selected (Default), show sessions with no profileId
          return !s.profileId;
        }
        return s.profileId === currentProfileId;
      });
      setDisplayedSessions(filteredSessions);
    });
  }, [sessions, profileStore.currentProfileId]);

  const rowVirtualizer = useVirtualizer({
    count: displayedSessions.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => (narrow ? 10 : 78),
    // cSpell:ignore overscan
    overscan: 10,
  });
  const onDragEnd: OnDragEndResponder = (result) => {
    const { destination, source } = result;
    if (!destination) {
      return;
    }

    if (
      destination.droppableId === source.droppableId &&
      destination.index === source.index
    ) {
      return;
    }

    const { currentProfileId } = profileStore;
    // We need to map the visual index to the real index in the sessions array
    // However, the `moveSession` action expects indices.
    // If we are filtering, we can't easily use index-based move directly if it relies on absolute positions.
    // The current implementation of `moveSession` in `store/chat.ts` uses indices on the full `sessions` array.
    // If we move item from index 0 to 1 in the filtered view, we need to find their real indices in the full list.

    const fromSession = displayedSessions[source.index];
    const toSession = displayedSessions[destination.index];

    const realFromIndex = sessions.findIndex((s) => s.id === fromSession.id);
    const realToIndex = sessions.findIndex((s) => s.id === toSession.id);

    if (realFromIndex !== -1 && realToIndex !== -1) {
      moveSession(realFromIndex, realToIndex);
    }
  };
  if (!hasHydrated || isPending) {
    console.log(
      `[ChatList Render] Rendering SKELETON if hasHydrated is false: (${hasHydrated}) or isPending is true: (${isPending}).`,
    );
    return <ChatListSkeleton narrow={narrow} />;
  }

  return (
    <DragDropContext onDragEnd={onDragEnd}>
      <Droppable droppableId="chat-list">
        {(provided) => (
          <div
            className={styles["chat-list"]}
            ref={(el) => {
              dndContainerRef.current = el;
              provided.innerRef(el);
            }}
            {...provided.droppableProps}
          >
            <div
              style={{
                height: `${rowVirtualizer.getTotalSize()}px`,
                width: "100%",
                position: "relative",
              }}
            >
              {rowVirtualizer.getVirtualItems().map((virtualItem) => {
                const item = displayedSessions[virtualItem.index];
                if (!item) return null;
                return (
                  <div
                    key={item.id}
                    style={{
                      position: "absolute",
                      top: 0,
                      left: 0,
                      width: "100%",
                      height: `${virtualItem.size}px`,
                      transform: `translateY(${virtualItem.start}px)`,
                    }}
                  >
                    <ChatItem
                      title={item.topic}
                      time={new Date(item.lastUpdate).toLocaleString()}
                      count={item.messages.length}
                      id={item.id}
                      index={virtualItem.index}
                      selected={virtualItem.index === selectedIndex}
                      onClick={() => {
                        navigate(Path.Chat);
                        // Find the real index of this session
                        const realIndex = sessions.findIndex(
                          (s) => s.id === item.id,
                        );
                        if (realIndex !== -1) {
                          selectSession(realIndex);
                        }
                      }}
                      onDelete={async () => {
                        if (
                          (!narrow && !isMobileScreen) ||
                          (await showConfirm(Locale.Home.DeleteChat))
                        ) {
                          // Find the real index of this session
                          const realIndex = sessions.findIndex(
                            (s) => s.id === item.id,
                          );
                          if (realIndex !== -1) {
                            chatStore.deleteSession(realIndex);
                          }
                        }
                      }}
                      narrow={narrow}
                      mask={item.mask}
                      isPinned={item.pinned ?? false}
                    />
                  </div>
                );
              })}
            </div>
            {provided.placeholder}
          </div>
        )}
      </Droppable>
    </DragDropContext>
  );
}
