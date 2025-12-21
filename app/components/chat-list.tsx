import KebabMenuIcon from "../icons/kebab-menu.svg";
import { IconButton } from "./button";
import React, { useState, useEffect, useRef, useTransition, memo } from "react";
import { useShallow } from "zustand/react/shallow";
import styles from "./home.module.scss";
import {
  DragDropContext,
  Droppable,
  Draggable,
  OnDragEndResponder,
} from "@hello-pangea/dnd";

import { useVirtualizer } from "@tanstack/react-virtual";
import { useChatStore } from "../store";
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
    useShallow((state) => ({
      openMenu: state.openMenu,
      closeMenu: state.closeMenu,
    })),
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
  scrollRef: React.RefObject<HTMLDivElement | null>;
}) {
  const { sessions, selectedIndex, selectSession, moveSession, hasHydrated } =
    useChatStore(
      useShallow((state) => ({
        sessions: state.sessions,
        selectedIndex: state.currentSessionIndex,
        selectSession: state.selectSession,
        moveSession: state.moveSession,
        hasHydrated: state._hasHydrated,
      })),
    );
  const chatStore = useChatStore();
  const navigate = useNavigate();
  const isMobileScreen = useMobileScreen();
  const [isPending, startTransition] = useTransition();
  const [displayedSessions, setDisplayedSessions] = useState(sessions);
  const dndContainerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    startTransition(() => {
      setDisplayedSessions(sessions);
    });
  }, [sessions]);

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

    moveSession(source.index, destination.index);
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
                        selectSession(virtualItem.index);
                      }}
                      onDelete={async () => {
                        if (
                          (!narrow && !isMobileScreen) ||
                          (await showConfirm(Locale.Home.DeleteChat))
                        ) {
                          chatStore.deleteSession(virtualItem.index);
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
