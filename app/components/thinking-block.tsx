import React, { useState, useEffect, useRef } from "react";
import { Markdown } from "./markdown";
import { formatReasoningDuration } from "@/app/utils";
import styles from "./thinking-block.module.scss";

export interface ThinkingBlockProps {
  thinkingContent: string;
  isStreaming: boolean;
  reasoningDurationMs?: number;
  fontSize?: number;
  fontFamily?: string;
}

interface ThinkingPillProps {
  isActive: boolean;
  durationMs?: number;
  onClick: () => void;
  isExpanded: boolean;
}

function SparkleIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      width="18"
      height="18"
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M8 1L9.5 6.5L15 8L9.5 9.5L8 15L6.5 9.5L1 8L6.5 6.5L8 1Z"
        fill="currentColor"
      />
    </svg>
  );
}

function ChevronIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      width="2em"
      height="2em"
      viewBox="0 0 14 14"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M4.5 5.5L7 8L9.5 5.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ThinkingPill({
  isActive,
  durationMs,
  onClick,
  isExpanded,
}: ThinkingPillProps) {
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const startTimeRef = useRef<number | null>(null);

  useEffect(() => {
    if (isActive) {
      startTimeRef.current = Date.now();
      setElapsedSeconds(0);

      const intervalId = setInterval(() => {
        if (startTimeRef.current != null) {
          const elapsed = Math.floor(
            (Date.now() - startTimeRef.current) / 1000,
          );
          setElapsedSeconds(elapsed);
        }
      }, 1000);

      return () => {
        clearInterval(intervalId);
      };
    } else {
      startTimeRef.current = null;
      setElapsedSeconds(0);
    }
  }, [isActive]);

  let label: string;
  if (isActive && durationMs == null) {
    label =
      elapsedSeconds > 0 ? `Thinking... ${elapsedSeconds}s` : "Thinking...";
  } else {
    label = formatReasoningDuration(durationMs ?? 0);
  }

  return (
    <div
      className={styles["thinking-pill"]}
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
    >
      <SparkleIcon
        className={`${styles["sparkle-icon"]} ${
          isActive ? styles["pulse"] : ""
        }`}
      />
      <span
        className={`${styles["pill-label"]} ${
          isActive ? styles["shimmer"] : ""
        }`}
      >
        {label}
      </span>
      {!isActive && (
        <ChevronIcon
          className={`${styles["chevron-icon"]} ${
            isExpanded ? styles["chevron-expanded"] : ""
          }`}
        />
      )}
    </div>
  );
}

export function ThinkingBlock({
  thinkingContent,
  isStreaming,
  reasoningDurationMs,
  fontSize,
  fontFamily,
}: ThinkingBlockProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  if (!thinkingContent) return null;

  const isActive = isStreaming && reasoningDurationMs == null;

  return (
    <div className={styles["thinking-block"]}>
      <ThinkingPill
        isActive={isActive}
        durationMs={reasoningDurationMs}
        onClick={() => setIsExpanded((prev) => !prev)}
        isExpanded={isExpanded}
      />
      <div
        className={`${styles["thinking-content"]} ${
          isExpanded ? styles["expanded"] : ""
        }`}
      >
        <div className={styles["thinking-content-inner"]}>
          <Markdown
            content={thinkingContent}
            fontSize={fontSize}
            fontFamily={fontFamily}
          />
        </div>
      </div>
    </div>
  );
}

export default ThinkingBlock;
