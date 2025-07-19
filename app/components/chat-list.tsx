import KebabMenuIcon from "../icons/kebab-menu.svg";
import { IconButton } from "./button";
import React, { useState, useEffect, useRef } from "react";
import { shallow } from "zustand/shallow";
import styles from "./home.module.scss";
import {
  DragDropContext,
  Droppable,
  Draggable,
  OnDragEndResponder,
} from "@hello-pangea/dnd";

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

export function ChatItem(props: {
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
}) {
  const draggableRef = useRef<HTMLDivElement | null>(null);
  const [isHovered, setIsHovered] = useState(false);
  const { isMenuOpen, menuSessionId, openMenu, closeMenu, isPinned } =
    useChatStore(
      (state) => ({
        openMenu: state.openMenu,
        closeMenu: state.closeMenu,
        isMenuOpen: state.isMenuOpen,
        menuSessionId: state.menuSessionId,
        isPinned:
          state.sessions.find((s) => s.id === props.id)?.pinned ?? false,
      }),
      shallow,
    );
  const [isAnimatingPin, setIsAnimatingPin] = useState(false);
  const [isAnimatingUnpin, setIsAnimatingUnpin] = useState(false);
  const prevPinnedStatusRef = useRef(isPinned);

  useEffect(() => {
    if (props.selected && draggableRef.current) {
      draggableRef.current?.scrollIntoView({
        block: "center",
      });
    }
  }, [props.selected]);

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
    <Draggable draggableId={`${props.id}`} index={props.index}>
      {(provided) => (
        <div
          className={clsx(styles["chat-item"], {
            [styles["chat-item-selected"]]:
              props.selected &&
              (currentPath === Path.Chat || currentPath === Path.Home),
            [styles["chat-item-pinned"]]: isPinned,
            [styles["chat-item-animating-pin"]]: isAnimatingPin,
            [styles["chat-item-animating-unpin"]]: isAnimatingUnpin,
          })}
          onClick={props.onClick}
          onMouseEnter={() => setIsHovered(true)}
          onMouseLeave={() => setIsHovered(false)}
          ref={(ele) => {
            draggableRef.current = ele;
            provided.innerRef(ele);
          }}
          {...provided.draggableProps}
          {...provided.dragHandleProps}
          title={`${props.title}\n${Locale.ChatItem.ChatItemCount(
            props.count,
          )}`}
        >
          {!props.narrow && (
            <div
              className={styles["chat-item-menu-icon-container"]}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                if (isMenuOpen && menuSessionId === props.id) {
                  closeMenu();
                } else {
                  const rect = e.currentTarget.getBoundingClientRect();
                  openMenu(props.id, {
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
          {props.narrow ? (
            <div className={styles["chat-item-narrow"]}>
              <div className={clsx(styles["chat-item-avatar"], "no-dark")}>
                <MaskAvatar
                  avatar={props.mask.avatar}
                  model={props.mask.modelConfig.model}
                />
              </div>
              <div className={styles["chat-item-narrow-count"]}>
                {props.count}
              </div>
            </div>
          ) : (
            <>
              <div className={styles["chat-item-title"]}>{props.title}</div>
              <div className={styles["chat-item-info"]}>
                <div className={styles["chat-item-count"]}>
                  {Locale.ChatItem.ChatItemCount(props.count)}
                </div>
                <div className={styles["chat-item-date"]}>{props.time}</div>
              </div>
            </>
          )}
          {/* The old delete icon is removed from here */}
        </div>
      )}
    </Draggable>
  );
}

export function ChatList(props: { narrow?: boolean }) {
  const [sessions, selectedIndex, selectSession, moveSession] = useChatStore(
    (state) => [
      state.sessions,
      state.currentSessionIndex,
      state.selectSession,
      state.moveSession,
    ],
    shallow,
  );
  const chatStore = useChatStore();
  const navigate = useNavigate();
  const isMobileScreen = useMobileScreen();

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

  return (
    <DragDropContext onDragEnd={onDragEnd}>
      <Droppable droppableId="chat-list">
        {(provided) => (
          <div
            className={styles["chat-list"]}
            ref={provided.innerRef}
            {...provided.droppableProps}
          >
            {sessions.map((item, i) => (
              <ChatItem
                title={item.topic}
                time={new Date(item.lastUpdate).toLocaleString()}
                count={item.messages.length}
                key={item.id}
                id={item.id}
                index={i}
                selected={i === selectedIndex}
                onClick={() => {
                  navigate(Path.Chat);
                  selectSession(i);
                }}
                onDelete={async () => {
                  if (
                    (!props.narrow && !isMobileScreen) ||
                    (await showConfirm(Locale.Home.DeleteChat))
                  ) {
                    chatStore.deleteSession(i);
                  }
                }}
                narrow={props.narrow}
                mask={item.mask}
              />
            ))}
            {provided.placeholder}
          </div>
        )}
      </Droppable>
    </DragDropContext>
  );
}
