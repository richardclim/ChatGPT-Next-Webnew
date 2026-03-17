import React from "react";
import { render, screen, fireEvent, act } from "@testing-library/react";

// Mock SCSS module with explicit class name mapping
jest.mock("./thinking-block.module.scss", () => ({
  "thinking-block": "thinking-block",
  "thinking-pill": "thinking-pill",
  "sparkle-icon": "sparkle-icon",
  pulse: "pulse",
  "pill-label": "pill-label",
  "chevron-icon": "chevron-icon",
  "chevron-expanded": "chevron-expanded",
  "thinking-content": "thinking-content",
  expanded: "expanded",
  "thinking-content-inner": "thinking-content-inner",
}));

// Mock Markdown component to avoid react-markdown/rehype dependency chain
jest.mock("./markdown", () => ({
  Markdown: ({ content }: { content: string }) => (
    <div data-testid="markdown">{content}</div>
  ),
}));

// Mock the store to avoid nanoid/lodash-es ESM issues
jest.mock("@/app/store", () => ({}));

// Mock ui-lib to avoid deep imports
jest.mock("@/app/components/ui-lib", () => ({}));

// Mock formatReasoningDuration
jest.mock("@/app/utils", () => ({
  formatReasoningDuration: (ms: number) => {
    const seconds = Math.max(1, Math.round(ms / 1000));
    return `Thought for ${seconds}s`;
  },
}));

import { ThinkingBlock } from "./thinking-block";

describe("ThinkingBlock", () => {
  test("renders collapsed by default when thinkingContent is provided", () => {
    const { container } = render(
      <ThinkingBlock
        thinkingContent="Some reasoning content"
        isStreaming={false}
        reasoningDurationMs={3000}
      />,
    );

    // Pill should be visible
    expect(screen.getByText("Thought for 3s")).toBeInTheDocument();

    // Content wrapper should not have the expanded class
    const contentDiv = container.querySelector(".thinking-content");
    expect(contentDiv).toBeInTheDocument();
    expect(contentDiv).not.toHaveClass("expanded");
  });

  test("toggles expanded/collapsed on click", () => {
    const { container } = render(
      <ThinkingBlock
        thinkingContent="Some reasoning content"
        isStreaming={false}
        reasoningDurationMs={5000}
      />,
    );

    const pill = screen.getByRole("button");
    const contentDiv = container.querySelector(".thinking-content")!;

    // Initially collapsed
    expect(contentDiv).not.toHaveClass("expanded");

    // Click to expand
    fireEvent.click(pill);
    expect(contentDiv).toHaveClass("expanded");

    // Click to collapse
    fireEvent.click(pill);
    expect(contentDiv).not.toHaveClass("expanded");
  });

  test('shows "Thinking..." when isStreaming=true and no duration', () => {
    render(
      <ThinkingBlock
        thinkingContent="Partial reasoning..."
        isStreaming={true}
      />,
    );

    expect(screen.getByText("Thinking...")).toBeInTheDocument();
  });

  test('shows "Thought for Xs" when duration is provided', () => {
    render(
      <ThinkingBlock
        thinkingContent="Full reasoning content"
        isStreaming={false}
        reasoningDurationMs={7500}
      />,
    );

    // 7500ms rounds to 8s
    expect(screen.getByText("Thought for 8s")).toBeInTheDocument();
  });

  test("shows elapsed seconds in real time while streaming", () => {
    jest.useFakeTimers();

    render(
      <ThinkingBlock
        thinkingContent="Reasoning in progress..."
        isStreaming={true}
      />,
    );

    // Initially shows "Thinking..." with no elapsed time
    expect(screen.getByText("Thinking...")).toBeInTheDocument();

    // After 1 second, should show elapsed time
    act(() => {
      jest.advanceTimersByTime(1000);
    });
    expect(screen.getByText("Thinking... 1s")).toBeInTheDocument();

    // After another second
    act(() => {
      jest.advanceTimersByTime(1000);
    });
    expect(screen.getByText("Thinking... 2s")).toBeInTheDocument();

    jest.useRealTimers();
  });

  test("clears timer when streaming ends", () => {
    jest.useFakeTimers();

    const { rerender } = render(
      <ThinkingBlock thinkingContent="Reasoning..." isStreaming={true} />,
    );

    // Advance to show elapsed time
    act(() => {
      jest.advanceTimersByTime(2000);
    });
    expect(screen.getByText("Thinking... 2s")).toBeInTheDocument();

    // Streaming ends, duration is now known
    rerender(
      <ThinkingBlock
        thinkingContent="Reasoning..."
        isStreaming={false}
        reasoningDurationMs={2000}
      />,
    );

    expect(screen.getByText("Thought for 2s")).toBeInTheDocument();

    jest.useRealTimers();
  });
});
