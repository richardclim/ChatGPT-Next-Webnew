// src/components/ChatMenuPortal.tsx
import React, { useRef, useCallback, useEffect, RefObject } from "react";
import { useChatStore } from "../store";
import styles from "./home.module.scss";
import Locale from "../locales";
import { shallow } from "zustand/shallow";
import { useMobileScreen } from "../utils";

import DeleteIcon from "../icons/delete.svg";
import PinIcon from "../icons/pin.svg";
import UnpinIcon from "../icons/unpin.svg";
import EditIcon from "../icons/rename.svg";

export function ChatMenuPortal() {
  const menuRef = useRef<HTMLDivElement>(null);
  const isMobileScreen = useMobileScreen();
  const {
    isMenuOpen,
    menuPosition,
    closeMenu,
    sessionIndex,
    session,
    pinSession,
    unpinSession,
    updateSessionTopic,
    deleteSession,
  } = useChatStore((state) => {
    const sessionIndex = state.sessions.findIndex(
      (s) => s.id === state.menuSessionId,
    );
    const session = sessionIndex !== -1 ? state.sessions[sessionIndex] : null;
    return {
      isMenuOpen: state.isMenuOpen,
      closeMenu: state.closeMenu,
      menuSessionId: state.menuSessionId,
      menuPosition: state.menuPosition,
      sessionIndex,
      session,
      pinSession: state.pinSession,
      unpinSession: state.unpinSession,
      updateSessionTopic: state.updateSessionTopic,
      deleteSession: state.deleteSession,
    };
  }, shallow);

  // Use the outside click handler to close the menu
  useOutsideAlerter(
    menuRef,
    useCallback(() => {
      if (isMenuOpen) {
        closeMenu();
      }
    }, [isMenuOpen, closeMenu]),
    isMenuOpen && !isMobileScreen,
  );

  if (!isMenuOpen || !session) {
    return null; // Don't render anything if the menu is closed or session not found
  }
  const menuContent = (
    <>
      {/* Pin/Unpin Button */}
      <div
        className={styles["chat-item-menu-popup-button"]}
        onClick={() => {
          if (session.pinned) {
            unpinSession(sessionIndex);
          } else {
            pinSession(sessionIndex);
          }
          closeMenu();
        }}
      >
        {session.pinned ? <UnpinIcon /> : <PinIcon />}
        {session.pinned ? Locale.ChatItem.Unpin : Locale.ChatItem.Pin}
      </div>

      {/* Rename Button */}
      <div
        className={styles["chat-item-menu-popup-button"]}
        onClick={() => {
          closeMenu(); // Close menu before showing prompt
          const newName = window.prompt(
            Locale.ChatItem.RenameContent,
            session.topic,
          );
          if (newName && newName.trim() !== "") {
            updateSessionTopic(sessionIndex, newName.trim());
          }
        }}
      >
        <EditIcon />
        {Locale.ChatItem.Rename}
      </div>

      {/* Delete Button */}
      <div
        className={styles["chat-item-menu-popup-button"]}
        onClick={() => {
          deleteSession(sessionIndex);
          closeMenu();
        }}
      >
        <DeleteIcon />
        {Locale.ChatItem.Delete}
      </div>
    </>
  );

  if (isMobileScreen) {
    return (
      <div
        className={styles["chat-item-menu-mobile-backdrop"]}
        onClick={closeMenu}
      >
        <div
          className={styles["chat-item-menu-popup-mobile"]}
          ref={menuRef}
          onClick={(e) => {
            e.preventDefault();
          }}
        >
          {menuContent}
        </div>
      </div>
    );
  }

  return (
    <div
      className={styles["chat-item-menu-popup"]}
      ref={menuRef}
      style={{
        top: `${menuPosition.top}px`,
        left: `${menuPosition.left}px`,
      }}
      onClick={(e) => {
        e.preventDefault();
      }}
    >
      {menuContent}
    </div>
  );
}

function useOutsideAlerter(
  ref: RefObject<HTMLDivElement>,
  callback: () => void,
  isOpen: boolean,
) {
  useEffect(() => {
    if (!isOpen) {
      return;
    }

    function handleClickOutside(event: MouseEvent | TouchEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        callback();
      }
    }

    document.addEventListener("click", handleClickOutside);

    return () => {
      document.removeEventListener("click", handleClickOutside);
    };
  }, [ref, callback, isOpen]); // Add isOpen to dependency array
}
