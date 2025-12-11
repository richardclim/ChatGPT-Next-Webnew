// ==UserScript==
// @name         External AI Chat Bridge
// @namespace    ChatApp
// @version      0.5
// @description  Bridge external AI website with local Chat App
// @author       You
// @match        https://aistudio.google.com/u/1/prompts/*
// @match        https://aistudio.google.com/prompts/*
// @connect      localhost
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @run-at       document-start
// ==/UserScript==

// --- CRITICAL PATCHES: Apply BEFORE page scripts load ---
// These must run at document-start to intercept Angular's initialization

// Patch requestAnimationFrame to work in background tabs
// Angular CDK virtual scroll uses RAF for rendering
const originalRAF = unsafeWindow.requestAnimationFrame;
unsafeWindow.requestAnimationFrame = function (callback) {
  return setTimeout(callback, 16); // 16ms ≈ 60fps
};
unsafeWindow.cancelAnimationFrame = function (id) {
  clearTimeout(id);
};

// Spoof visibility state - Angular checks these before rendering
Object.defineProperty(unsafeWindow.document, "visibilityState", {
  get: () => "visible",
  configurable: true,
});
Object.defineProperty(unsafeWindow.document, "hidden", {
  get: () => false,
  configurable: true,
});

// Patch IntersectionObserver to always report elements as visible
// Angular CDK virtual scroll uses IntersectionObserver to determine which items to render
// In background tabs, real intersection detection fails, so we fake it
const OriginalIntersectionObserver = unsafeWindow.IntersectionObserver;
unsafeWindow.IntersectionObserver = class FakeIntersectionObserver {
  constructor(callback, options) {
    this.callback = callback;
    this.options = options;
    this.observables = new Set();
  }

  observe(target) {
    this.observables.add(target);
    // Create a fake entry that says "this element is fully visible"
    const fakeEntry = {
      target: target,
      isIntersecting: true,
      intersectionRatio: 1,
      boundingClientRect: target.getBoundingClientRect(),
      intersectionRect: target.getBoundingClientRect(),
      rootBounds: null,
      time: performance.now(),
    };
    // Fire callback asynchronously (libraries expect this on next tick)
    setTimeout(() => {
      if (this.observables.has(target)) {
        this.callback([fakeEntry], this);
      }
    }, 50);
  }

  unobserve(target) {
    this.observables.delete(target);
  }

  disconnect() {
    this.observables.clear();
  }

  takeRecords() {
    return [];
  }
};

console.log(
  "[Bridge] Visibility + IntersectionObserver patches applied at document-start",
);

// Main script runs after DOM is ready
(function waitForDOM() {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", main);
  } else {
    main();
  }
})();

function main() {
  "use strict";

  const API_URL = "http://localhost:3000/api/external-chat";
  const POLL_INTERVAL = 1000;
  const SELECTORS = {
    NEW_CHAT_BUTTON: 'button[aria-label="New chat"][iconname="add"]',
    INPUT_BOX: "textarea.textarea",
    SUBMIT_BUTTON: 'button[aria-label="Run"]',
    RESPONSE: "ms-text-chunk.ng-star-inserted",
    THREE_DOTS_MENU: 'button[aria-label="Open options"]',
    COPY_MARKDOWN_BUTTON: "button.mat-mdc-menu-item:has(.copy-markdown-button)",
    TITLE_ELEMENT: "h1.mode-title",
    SCROLL_CONTAINER: "ms-autoscroll-container",
  };

  /**
   * Checks if generation is in progress by looking for "Stop" in the Run button's text.
   * @returns {boolean} - True if generation is in progress (Stop button visible)
   */
  function isGenerating() {
    const runBtn = document.querySelector(SELECTORS.SUBMIT_BUTTON);
    if (!runBtn) return false;
    const text = runBtn.textContent || "";
    return text.toLowerCase().includes("stop");
  }

  const SCROLL_CONFIG = {
    POST_SCROLL_DELAY: 500, // delay after scroll before extraction
  };
  let isProcessing = false;
  let audioContext = null;
  let oscillatorNode = null;
  let audioPlaying = false;

  function log(msg) {
    console.log("[Bridge]", msg);
  }

  /**
   * Starts continuous silent audio using AudioContext oscillator to prevent tab throttling.
   * Uses an inaudible frequency (1Hz) with zero gain for true silence.
   * Must be called from a user interaction (click/keypress).
   */
  function startContinuousSilentAudio() {
    if (audioPlaying) return;

    try {
      // Create AudioContext (handles vendor prefixes)
      const AudioContextClass =
        window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) {
        log("AudioContext not supported");
        return;
      }

      audioContext = new AudioContextClass();

      // Create oscillator with inaudible frequency
      oscillatorNode = audioContext.createOscillator();
      oscillatorNode.frequency.value = 1; // 1Hz - below human hearing

      // Create gain node set to zero for true silence
      const gainNode = audioContext.createGain();
      gainNode.gain.value = 0.001; // Nearly silent (0 can cause some browsers to optimize away)

      // Connect: oscillator -> gain -> destination
      oscillatorNode.connect(gainNode);
      gainNode.connect(audioContext.destination);

      // Start the oscillator
      oscillatorNode.start();
      audioPlaying = true;
      log(
        "AudioContext oscillator started - tab throttling should be prevented",
      );
    } catch (e) {
      log(
        "Failed to create AudioContext: " +
          e.message +
          " - click the page first",
      );
    }
  }

  /**
   * Stops the silent audio and cleans up AudioContext resources.
   */
  function stopContinuousSilentAudio() {
    if (oscillatorNode) {
      try {
        oscillatorNode.stop();
        oscillatorNode.disconnect();
      } catch (e) {
        // Ignore errors if already stopped
      }
      oscillatorNode = null;
    }
    if (audioContext) {
      try {
        audioContext.close();
      } catch (e) {
        // Ignore errors if already closed
      }
      audioContext = null;
    }
    audioPlaying = false;
    log("AudioContext stopped");
  }

  // Start continuous audio on first user interaction
  function onUserInteraction() {
    if (!audioPlaying) {
      startContinuousSilentAudio();
    }
  }
  document.addEventListener("click", onUserInteraction);
  document.addEventListener("keydown", onUserInteraction);

  /**
   * Finds the scrollable chat container element.
   * @returns {Element|null} - The scroll container element or null if not found
   */
  function findScrollContainer() {
    const container = document.querySelector(SELECTORS.SCROLL_CONTAINER);
    if (!container) {
      log("Scroll container not found, proceeding with extraction");
    }
    return container;
  }

  /**
   * Scrolls the chat container to the bottom to trigger content propagation.
   * Uses IntersectionObserver patch to ensure virtualized content renders.
   * @returns {Promise<boolean>} - True if scroll was successful, false otherwise
   */
  async function scrollToBottom() {
    try {
      const container = findScrollContainer();
      if (!container) {
        log("Scroll container not found, proceeding with extraction");
        return false;
      }
      // Force disable smooth scrolling to ensure immediate scroll
      container.style.setProperty("scroll-behavior", "auto", "important");

      // Scroll to bottom
      container.scrollTop = container.scrollHeight;
      // Force reflow to ensure browser calculates new geometry
      void container.offsetHeight;
      // Dispatch scroll event to notify Angular's virtual scroll
      container.dispatchEvent(new Event("scroll", { bubbles: true }));

      // Small delay to let the patched IntersectionObserver trigger rendering
      await wait(100);

      return true;
    } catch (error) {
      log("Scroll operation failed: " + error);
      return false;
    }
  }

  function poll() {
    if (isProcessing) return;
    GM_xmlhttpRequest({
      method: "GET",
      url: API_URL,
      onload: function (response) {
        try {
          const data = JSON.parse(response.responseText);
          if (
            data.success &&
            data.request &&
            data.request.status === "pending"
          ) {
            log("Received new request: " + data.request.content);
            processRequest(data.request);
          }
        } catch (e) {
          log("Error parsing response: " + e);
        }
      },
      onerror: function (e) {
        log("Poll error: " + e);
      },
    });
  }

  async function processRequest(request) {
    isProcessing = true;

    // Acknowledge the request immediately to prevent duplicates
    await acknowledgeRequest(request.id);

    if (request.isNewChat) {
      log("Starting new chat...");
      if (click(SELECTORS.NEW_CHAT_BUTTON)) {
        await wait(2000);
      }
    }
    await scrollToBottom();
    const input = document.querySelector(SELECTORS.INPUT_BOX);
    if (input) {
      input.value = request.content;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await wait(500);
      click(SELECTORS.SUBMIT_BUTTON);
      await waitForGeneration();

      // Scroll to bottom and extract
      await scrollToBottom();
      await wait(SCROLL_CONFIG.POST_SCROLL_DELAY);

      const extractionResult = extractMarkdownFromDOM();
      const title = request.isNewChat ? extractTitle() : null;
      sendResponse(request.id, extractionResult, title);
    } else {
      log("Input box not found");
      isProcessing = false;
    }
  }

  function acknowledgeRequest(id) {
    return new Promise((resolve) => {
      GM_xmlhttpRequest({
        method: "POST",
        url: API_URL,
        data: JSON.stringify({
          action: "acknowledge",
          id: id,
        }),
        headers: {
          "Content-Type": "application/json",
        },
        onload: function () {
          log("Request acknowledged");
          resolve();
        },
        onerror: function () {
          log("Failed to acknowledge request");
          resolve();
        },
      });
    });
  }

  function click(selector) {
    const el = document.querySelector(selector);
    if (el) {
      el.click();
      return true;
    }
    log("Element not found: " + selector);
    return false;
  }

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function waitForGeneration() {
    log("Waiting for generation...");

    const POLL_MS = 200;
    const POST_GENERATION_DELAY = 3000; // Wait 3 seconds after stop button disappears

    // Wait for generation to start (stop button appears) or timeout
    const startTime = Date.now();
    while (!isGenerating() && Date.now() - startTime < 15000) {
      await wait(POLL_MS);
    }
    if (!isGenerating()) {
      log("Generation never detected after 15s - proceeding");
      return;
    }
    log("Generation started");
    while (isGenerating()) {
      await wait(POLL_MS);
    }
    await wait(POST_GENERATION_DELAY);
    log("Generation complete");
  }

  /**
   * Extracts markdown from the DOM.
   * Finds the last ms-chat-turn and extracts the last ms-text-chunk within it.
   * @returns {string} - The extracted markdown or error message
   */
  function extractMarkdownFromDOM() {
    log("Extracting markdown from DOM...");

    const container = findScrollContainer();
    const searchRoot = container || document;

    // Find all chat turns - each turn contains thinking + response chunks
    const chatTurns = searchRoot.querySelectorAll("ms-chat-turn");

    if (chatTurns.length === 0) {
      // Fallback to old method
      const responses = searchRoot.querySelectorAll(SELECTORS.RESPONSE);
      if (responses.length === 0) {
        return "Error: No response elements found";
      }
      const lastResponse = responses[responses.length - 1];
      try {
        return convertNodeToMarkdown(lastResponse).trim();
      } catch (e) {
        return "Error: Markdown extraction failed - " + e.message;
      }
    }

    // Get the last chat turn
    const lastTurn = chatTurns[chatTurns.length - 1];
    const chunks = lastTurn.querySelectorAll(SELECTORS.RESPONSE);

    if (chunks.length === 0) {
      return "Error: No content in last turn";
    }
    // Get the LAST chunk in this turn (the actual response, not thinking)
    const lastChunk = chunks[chunks.length - 1];

    try {
      const markdown = convertNodeToMarkdown(lastChunk);
      log("Markdown extracted successfully");
      return markdown.trim();
    } catch (e) {
      log("Markdown extraction failed: " + e);
      return "Error: Markdown extraction failed - " + e.message;
    }
  }

  function extractTitle() {
    const titleEl = document.querySelector(SELECTORS.TITLE_ELEMENT);
    if (titleEl && titleEl.textContent) {
      const title = titleEl.textContent.trim();
      if (title) {
        log("Title extracted: " + title);
        return title;
      }
    }
    log("Title element not found");
    return null;
  }

  function convertNodeToMarkdown(node, listDepth = 0) {
    let result = "";

    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        result += child.textContent;
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        const tag = child.tagName.toLowerCase();

        if (tag === "pre") {
          const code = child.querySelector("code");
          if (code) {
            const className = code.className || "";
            const langMatch = className.match(/language-(\w+)/);
            const lang = langMatch ? langMatch[1] : "";
            result += "\n```" + lang + "\n" + code.textContent + "\n```\n";
          } else {
            result += "\n```\n" + child.textContent + "\n```\n";
          }
        } else if (tag === "code" && child.parentElement?.tagName !== "PRE") {
          result += "`" + child.textContent + "`";
        } else if (tag === "strong" || tag === "b") {
          result += "**" + convertNodeToMarkdown(child, listDepth) + "**";
        } else if (tag === "em" || tag === "i") {
          result += "*" + convertNodeToMarkdown(child, listDepth) + "*";
        } else if (tag === "span") {
          const style = child.getAttribute("style") || "";
          if (
            style.includes("font-style: italic") ||
            style.includes("font-style:italic")
          ) {
            result += "*" + convertNodeToMarkdown(child, listDepth) + "*";
          } else {
            result += convertNodeToMarkdown(child, listDepth);
          }
        } else if (tag === "h1") {
          result += "\n# " + convertNodeToMarkdown(child, listDepth) + "\n";
        } else if (tag === "h2") {
          result += "\n## " + convertNodeToMarkdown(child, listDepth) + "\n";
        } else if (tag === "h3") {
          result += "\n### " + convertNodeToMarkdown(child, listDepth) + "\n";
        } else if (tag === "h4") {
          result += "\n#### " + convertNodeToMarkdown(child, listDepth) + "\n";
        } else if (tag === "p") {
          result += "\n" + convertNodeToMarkdown(child, listDepth) + "\n";
        } else if (tag === "br") {
          result += "\n";
        } else if (tag === "hr") {
          result += "\n---\n";
        } else if (tag === "table") {
          result += "\n" + convertTableToMarkdown(child) + "\n";
        } else if (tag === "ul" || tag === "ol") {
          result +=
            "\n" + convertListToMarkdown(child, tag === "ol", listDepth) + "\n";
        } else if (tag === "li") {
          result += convertNodeToMarkdown(child, listDepth);
        } else if (tag === "a") {
          const href = child.getAttribute("href") || "";
          result +=
            "[" + convertNodeToMarkdown(child, listDepth) + "](" + href + ")";
        } else if (tag === "blockquote") {
          const inner = convertNodeToMarkdown(child, listDepth)
            .trim()
            .split("\n")
            .join("\n> ");
          result += "\n> " + inner + "\n";
        } else {
          result += convertNodeToMarkdown(child, listDepth);
        }
      }
    }

    return result;
  }

  function convertTableToMarkdown(tableNode) {
    const rows = [];
    let headerProcessed = false;

    // Find all tr elements (may be nested in tbody, thead, or directly in table)
    const trElements = tableNode.querySelectorAll("tr");

    for (const tr of trElements) {
      const cells = [];
      const cellElements = tr.querySelectorAll("td, th");

      for (const cell of cellElements) {
        // Get cell content, converting any nested markdown
        const cellContent = convertNodeToMarkdown(cell)
          .trim()
          .replace(/\n/g, " ");
        cells.push(cellContent);
      }

      if (cells.length > 0) {
        rows.push("| " + cells.join(" | ") + " |");

        if (!headerProcessed) {
          const separator = cells.map(() => "---").join(" | ");
          rows.push("| " + separator + " |");
          headerProcessed = true;
        }
      }
    }

    return rows.join("\n");
  }

  function convertListToMarkdown(listNode, isOrdered, depth = 0) {
    let result = "";
    let index = 1;
    const indent = "  ".repeat(depth);
    const liElements = findDirectListItems(listNode);

    for (const li of liElements) {
      const prefix = isOrdered ? index + ". " : "- ";

      let inlineContent = "";
      let nestedLists = "";

      for (const liChild of li.childNodes) {
        if (liChild.nodeType === Node.TEXT_NODE) {
          inlineContent += liChild.textContent;
        } else if (liChild.nodeType === Node.ELEMENT_NODE) {
          const childTag = liChild.tagName.toLowerCase();
          if (childTag === "ul" || childTag === "ol") {
            // Handle nested lists with increased depth
            nestedLists +=
              "\n" +
              convertListToMarkdown(liChild, childTag === "ol", depth + 1);
          } else if (childTag === "p") {
            // Handle <p> inside <li> - extract content without extra newlines
            inlineContent += convertNodeToMarkdown(liChild, depth).trim();
          } else {
            // For any other element, check if it contains a nested list
            const nestedList = liChild.querySelector("ul, ol");
            if (nestedList) {
              // Extract inline content first (everything except the nested list)
              inlineContent += convertNodeToMarkdownExcludingLists(liChild);
              // Then handle the nested list
              const isNestedOrdered = nestedList.tagName.toLowerCase() === "ol";
              nestedLists +=
                "\n" +
                convertListToMarkdown(nestedList, isNestedOrdered, depth + 1);
            } else {
              inlineContent += convertNodeToMarkdown(liChild, depth);
            }
          }
        }
      }

      result += indent + prefix + inlineContent.trim();
      if (nestedLists) {
        result += nestedLists;
      }
      result += "\n";
      index++;
    }

    return result.trimEnd();
  }

  // Helper to extract content from a node but skip ul/ol elements
  function convertNodeToMarkdownExcludingLists(node) {
    let result = "";

    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        result += child.textContent;
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        const tag = child.tagName.toLowerCase();
        // Skip ul/ol - they're handled separately
        if (tag === "ul" || tag === "ol") {
          continue;
        }
        // For other elements, recurse but still exclude lists
        if (tag === "strong" || tag === "b") {
          result += "**" + convertNodeToMarkdownExcludingLists(child) + "**";
        } else if (tag === "em" || tag === "i") {
          result += "*" + convertNodeToMarkdownExcludingLists(child) + "*";
        } else if (tag === "span") {
          const style = child.getAttribute("style") || "";
          if (
            style.includes("font-style: italic") ||
            style.includes("font-style:italic")
          ) {
            result += "*" + convertNodeToMarkdownExcludingLists(child) + "*";
          } else {
            result += convertNodeToMarkdownExcludingLists(child);
          }
        } else if (tag === "p") {
          result += convertNodeToMarkdownExcludingLists(child).trim();
        } else {
          result += convertNodeToMarkdownExcludingLists(child);
        }
      }
    }

    return result;
  }

  function findDirectListItems(listNode) {
    const allLis = listNode.querySelectorAll("li");
    const directLis = [];

    for (const li of allLis) {
      const closestList = li.parentElement?.closest("ul, ol");
      if (closestList === listNode) {
        directLis.push(li);
      }
    }

    return directLis;
  }

  function sendResponse(id, content, title) {
    const body = {
      action: "response",
      id: id,
      content: content,
      ...(title && { title: title }),
    };
    GM_xmlhttpRequest({
      method: "POST",
      url: API_URL,
      data: JSON.stringify(body),
      headers: {
        "Content-Type": "application/json",
      },
      onload: function () {
        log("Response sent");
        isProcessing = false;
      },
    });
  }

  setInterval(poll, POLL_INTERVAL);
  log("Bridge started");
}
