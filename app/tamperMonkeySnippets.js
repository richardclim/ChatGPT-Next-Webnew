/* eslint-disable */
// This file contains TamperMonkey script snippets for reference only - not production code
document.querySelector('button[aria-label="New chat"]');
document.querySelector('button[iconname="add"]');
document.querySelector('button[data-test-clear="outside"]');
RESPONSE: "ms-text-chunk.ng-star-inserted",
const previewText = lastChunk.textContent?.substring(0, 100) || "";
/*
XPathResult.ANY_TYPE – let the engine decide the natural type.

XPathResult.UNORDERED_NODE_ITERATOR_TYPE / ORDERED_NODE_ITERATOR_TYPE – iterate nodes with iterateNext().

XPathResult.UNORDERED_NODE_SNAPSHOT_TYPE / ORDERED_NODE_SNAPSHOT_TYPE – random-access list via snapshotItem(i) and snapshotLength.

XPathResult.FIRST_ORDERED_NODE_TYPE – the first matching node.
*/

// This finds a span containing "add" inside a button
// this is an alternative solution if the attributes are messy or not clear.

var button = document.evaluate(
  "//button//span[contains(text(), 'add')]",
  document,
  null,
  XPathResult.FIRST_ORDERED_NODE_TYPE,
  null,
).singleNodeValue;
if (button) button.click();

// Attribute matches are exact match only. dot selectors means contains but can include other characters.

COPY_MARKDOWN_BUTTON: "button.mat-mdc-menu-item:has(.copy-markdown-button)";
COPY_MARKDOWN_BUTTON: 'button.mat-mdc-menu-item:has(span:contains("Copy as markdown"))';
COPY_MARKDOWN_BUTTON: "button:has(.copy-markdown-button)";
document.querySelector('button[data-test-clear="outside"][iconname="add"]');
document.querySelector("ms-autoscroll-container");

const response = document.querySelectorAll("ms-text-chunk.ng-star-inserted");
const lastResponse = response[response.length - 1];
console.log(
  `${
    lastResponse.textContent ||
    lastResponse.innerText ||
    "Error: Empty response"
  }`,
);

// ==UserScript==
// @name         External AI Chat Bridge
// @namespace    ChatApp
// @version      0.2
// @description  Bridge external AI website with local Chat App
// @author       You
// @match        https://aistudio.google.com/prompts/*
// @connect      localhost
// @grant        GM_xmlhttpRequest
// ==/UserScript==

(function () {
  "use strict";
  const API_URL = "http://localhost:3000/api/external-chat";
  const POLL_INTERVAL = 1000;
  const SELECTORS = {
    NEW_CHAT_BUTTON: 'button[aria-label="New chat"][iconname="add"]',
    INPUT_BOX: "textarea.textarea",
    SUBMIT_BUTTON: 'button[aria-label="Run"]',
    STOP_BUTTON: "button:has(.stoppable-stop)",
    RESPONSE: "ms-text-chunk.ng-star-inserted",
    THREE_DOTS_MENU: 'button[aria-label="Open options"]',
    COPY_MARKDOWN_BUTTON: "button.mat-mdc-menu-item:has(.copy-markdown-button)",
  };
  let isProcessing = false;

  function log(msg) {
    console.log("[Bridge]", msg);
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
    const input = document.querySelector(SELECTORS.INPUT_BOX);
    if (input) {
      input.value = request.content;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await wait(500);
      click(SELECTORS.SUBMIT_BUTTON);
      await waitForGeneration();
      const responseText = await copyMarkdown();
      sendResponse(request.id, responseText);
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
    await wait(2000);
    return new Promise((resolve) => {
      const check = setInterval(() => {
        const stopBtn = document.querySelector(SELECTORS.STOP_BUTTON);
        if (!stopBtn) {
          clearInterval(check);
          resolve();
        }
      }, 1000);
    });
  }

  async function copyMarkdown() {
    log("Copying markdown...");
    const errors = [];
    const response = document.querySelector(SELECTORS.RESPONSE);

    if (!response) {
      errors.push("No response elements found");
      return "Error: " + errors.join(" → ");
    }

    response.scrollIntoView({ behavior: "instant", block: "center" });
    await wait(300);

    response.dispatchEvent(
      new MouseEvent("mouseenter", { bubbles: true, cancelable: true }),
    );
    response.dispatchEvent(
      new MouseEvent("mouseover", { bubbles: true, cancelable: true }),
    );
    response.dispatchEvent(
      new PointerEvent("pointerenter", { bubbles: true, cancelable: true }),
    );
    response.dispatchEvent(
      new PointerEvent("pointermove", { bubbles: true, cancelable: true }),
    );
    await wait(800);

    if (!click(SELECTORS.THREE_DOTS_MENU)) {
      errors.push("Three dots menu not found after hover");
      return "Error: " + errors.join(" → ");
    }

    await wait(500);

    if (!click(SELECTORS.COPY_MARKDOWN_BUTTON)) {
      errors.push("Copy markdown button not found in menu");
      return "Error: " + errors.join(" → ");
    }

    await wait(500);

    try {
      return await navigator.clipboard.readText();
    } catch (e) {
      log("Clipboard read failed: " + e);
      return "Error: Clipboard read failed - " + e.message;
    }
  }

  function sendResponse(id, content) {
    GM_xmlhttpRequest({
      method: "POST",
      url: API_URL,
      data: JSON.stringify({
        action: "response",
        id: id,
        content: content,
      }),
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
})();

/* 
example html
<ul>
  <ms-cmark-node>
    <li>
      <ms-cmark-node>
        <p><strong>8:00 PM – 10:00 PM:</strong></p>
        <ul>
          <ms-cmark-node>
            <li><p><strong>Released:</strong> ~30-40%</p></li>
            <li><p><strong>Status:</strong> Loading phase</p></li>
          </ms-cmark-node>
        </ul>
      </ms-cmark-node>
    </li>
  </ms-cmark-node>
</ul>


convertListToMarkdown(outerUL, depth=0)
│
├─ findDirectListItems → [li1]
│
└─ Processing li1's children:
   └─ child = <ms-cmark-node>
      └─ Check: childTag === "ul"/"ol"? NO
      └─ Check: childTag === "p"? NO
      └─ ELSE branch:
         └─ querySelector("ul, ol")  ← searches ALL descendants
            ✅ FINDS the nested <ul> no matter how deep!
         │
         ├─ convertNodeToMarkdownExcludingLists(ms-cmark-node)
         │  │
         │  └─ Processes <p><strong>8:00 PM...</strong></p>
         │     └─ Skips <ul> when encountered
         │     └─ Returns: "**8:00 PM – 10:00 PM:**"
         │
         └─ convertListToMarkdown(nestedUL, depth=1)  ← proper recursion!
            │
            ├─ findDirectListItems → [nestedLi1, nestedLi2]
            │
            ├─ nestedLi1 → "  - **Released:** ~30-40%"
            └─ nestedLi2 → "  - **Status:** Loading phase"

        [Parent]
           │
    ┌──────┼──────┐
    │      │      │
 [A]    [B]    [C]      ← for loop handles these (siblings)
  │      │
 [A1]   [B1]            ← recursion handles these (depth)
  │
 [A1a]

WebSocket "Heartbeats"
Some real-time apps (like trading platforms or chat apps) detect if you are away and sever the WebSocket connection to save bandwidth, regardless of scrolling.
They often use window.onblur or check for mouse movement.
Fix: If the data stops flowing even though the scroll works, you might need to periodically dispatch fake mouse events:
code
JavaScript
setInterval(() => {
    document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 100, clientY: 100 }));
}, 5000);


*/
    function debugLogButtonState() {
      const runBtn = document.querySelector(SELECTORS.SUBMIT_BUTTON);
      if (runBtn) {
        log(`=== DEBUG: Run button state ===`);
        log(`  textContent: "${runBtn.textContent?.trim()}"`);
        log(`  innerHTML snippet: "${runBtn.innerHTML.substring(0, 200)}..."`);
        log(`  classes: "${runBtn.className}"`);
        log(`  aria-label: "${runBtn.getAttribute("aria-label")}"`);
        log(`  aria-disabled: "${runBtn.getAttribute("aria-disabled")}"`);
      } else {
        log(`=== DEBUG: Run button NOT FOUND ===`);
      }

      // Also check for any button with "stop" anywhere
      const allButtons = document.querySelectorAll("button");
      const stopButtons = Array.from(allButtons).filter((btn) => {
        const text = btn.textContent?.toLowerCase() || "";
        const ariaLabel = btn.getAttribute("aria-label")?.toLowerCase() || "";
        const classes = btn.className?.toLowerCase() || "";
        return (
          text.includes("stop") ||
          ariaLabel.includes("stop") ||
          classes.includes("stop")
        );
      });
      if (stopButtons.length > 0) {
        log(`=== DEBUG: Found ${stopButtons.length} buttons with 'stop' ===`);
        stopButtons.forEach((btn, i) => {
          log(
            `  [${i}] text="${btn.textContent?.trim()}", aria-label="${btn.getAttribute(
              "aria-label",
            )}", classes="${btn.className}"`,
          );
        });
      }
    }


    log(
      `Scroll complete: scrollTop=${container.scrollTop}, maxScroll=${maxScroll}, atBottom=${atBottom}, iterations=${iterations}`,
    );

    console.log(document.querySelectorAll('ms-text-chunk.ng-star-inserted').length);



    const debugStopBtns = document.querySelectorAll(
      'button[aria-label*="top"], button[aria-label*="Stop"]',
    );
    if (debugStopBtns.length > 0) {
      log(`Debug: Found ${debugStopBtns.length} potential stop buttons`);
      debugStopBtns.forEach((btn, i) => {
        log(
          `  Button ${i}: aria-label="${btn.getAttribute(
            "aria-label",
          )}", classes="${btn.className}"`,
        );
      });
    }


  async function incrementalScroll(container) {
    const { SCROLL_INCREMENT, SCROLL_STEP_DELAY } = SCROLL_CONFIG;
    const maxIterations = 200; // Prevent infinite loop
    let iterations = 0;

    // Force disable smooth scrolling with !important to override any CSS rules
    container.style.setProperty("scroll-behavior", "auto", "important");

    while (
      container.scrollTop + container.clientHeight < container.scrollHeight &&
      iterations < maxIterations
    ) {
      // Scroll by increment
      container.scrollTop += SCROLL_INCREMENT;

      // Force reflow by reading offsetHeight. This forces the browser to calculate the new geometry immediately
      void container.offsetHeight;

      // Dispatch synthetic scroll event to notify Angular's virtual scroll
      container.dispatchEvent(new Event("scroll", { bubbles: true }));

      console.log(`Background Scroll: ${container.scrollTop}`);
      await wait(SCROLL_STEP_DELAY);
      iterations++;
    }

    // Final scroll to ensure we're at the very bottom
    container.scrollTop = container.scrollHeight;
    void container.offsetHeight;
    container.dispatchEvent(new Event("scroll", { bubbles: true }));

    // Calculate if we're at the bottom (scrollTop should equal scrollHeight - clientHeight)
    const maxScroll = container.scrollHeight - container.clientHeight;
    const atBottom = Math.abs(container.scrollTop - maxScroll) < 5; // Allow 5px tolerance

    log(
      `Scroll complete: scrollTop=${container.scrollTop}, maxScroll=${maxScroll}, atBottom=${atBottom}, iterations=${iterations}`,
    );
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
    const input = document.querySelector(SELECTORS.INPUT_BOX);
    if (input) {
      input.value = request.content;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await wait(500);
      click(SELECTORS.SUBMIT_BUTTON);
      await waitForGeneration();

      // Scroll to bottom and extract with retry logic
      // Virtualization may need multiple scroll attempts to render newest content
      const MAX_SCROLL_ATTEMPTS = 5;
      const SCROLL_RETRY_DELAY = 1000; // 1 second between attempts

      let extractionResult = null;
      for (let attempt = 1; attempt <= MAX_SCROLL_ATTEMPTS; attempt++) {
        log(`Scroll attempt ${attempt}/${MAX_SCROLL_ATTEMPTS}...`);
        await scrollToBottom();
        await wait(SCROLL_RETRY_DELAY); // Longer delay to let virtualization render

        extractionResult = extractMarkdownFromDOM();

        // Check if extraction succeeded (no error about unrendered turns)
        if (
          !extractionResult.startsWith("Error:") &&
          !extractionResult.includes("not rendered")
        ) {
          log(`Extraction succeeded on attempt ${attempt}`);
          break;
        }

        log(`Attempt ${attempt} failed: ${extractionResult}`);

        if (attempt < MAX_SCROLL_ATTEMPTS) {
          log("Retrying scroll to trigger virtualization...");
        }
      }

      // If still failed after all attempts, defer until tab visible
      if (
        extractionResult.startsWith("Error:") ||
        extractionResult.includes("not rendered")
      ) {
        log(
          "Extraction failed after all attempts - deferring until tab becomes visible",
        );
        pendingExtraction = { id: request.id, isNewChat: request.isNewChat };
        return;
      }

      const title = request.isNewChat ? extractTitle() : null;
      sendResponse(request.id, extractionResult, title);
    } else {
      log("Input box not found");
      isProcessing = false;
    }
  }

  /**
   * Performs extraction after tab becomes visible (deferred from background)
   */
  async function performDeferredExtraction() {
    if (!pendingExtraction) return;

    const { id, isNewChat } = pendingExtraction;
    pendingExtraction = null;

    log("Performing deferred extraction...");

    // Scroll again now that tab is visible
    await scrollToBottom();
    await wait(SCROLL_CONFIG.POST_SCROLL_DELAY);

    const responseText = extractMarkdownFromDOM();
    const title = isNewChat ? extractTitle() : null;
    sendResponse(id, responseText, title);
  }

    function extractMarkdownFromDOM() {
    log("Extracting markdown from DOM...");

    const container = findScrollContainer();
    const searchRoot = container || document;

    // Debug: Log total response elements in different scopes
    const allInDocument = document.querySelectorAll(SELECTORS.RESPONSE).length;
    const allInContainer = container
      ? container.querySelectorAll(SELECTORS.RESPONSE).length
      : "N/A";
    log(
      `Response elements - document: ${allInDocument}, container: ${allInContainer}`,
    );

    // Find all chat turns - each turn contains thinking + response chunks
    const chatTurns = searchRoot.querySelectorAll("ms-chat-turn");
    log(`Found ${chatTurns.length} chat turns in DOM`);

    if (chatTurns.length === 0) {
      // Fallback to old method
      const responses = searchRoot.querySelectorAll(SELECTORS.RESPONSE);
      log(`Fallback: Found ${responses.length} response elements`);
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

    // Find the last chat turn that actually has content
    // (The very last turn might be empty due to virtualization not rendering it yet)
    let lastTurnWithContent = null;
    let chunksInTurn = [];
    let emptyTurnsAtEnd = 0;

    for (let i = chatTurns.length - 1; i >= 0; i--) {
      const turn = chatTurns[i];
      const chunks = turn.querySelectorAll(SELECTORS.RESPONSE);
      if (chunks.length > 0) {
        lastTurnWithContent = turn;
        chunksInTurn = chunks;
        log(
          `Found content in turn ${i + 1}/${chatTurns.length} with ${
            chunks.length
          } chunks`,
        );
        break;
      } else {
        emptyTurnsAtEnd++;
        log(`Turn ${i + 1}/${chatTurns.length} is empty (not rendered)`);
      }
    }

    // CRITICAL: If there are empty turns at the end, the newest content isn't rendered
    // Return an error to trigger retry/defer logic - do NOT fall back to stale content
    if (emptyTurnsAtEnd > 0) {
      log(
        `WARNING: ${emptyTurnsAtEnd} newest turn(s) not rendered - content may be stale`,
      );
      return `Error: ${emptyTurnsAtEnd} turn(s) not rendered - need to retry`;
    }

    if (!lastTurnWithContent || chunksInTurn.length === 0) {
      return "Error: No turns with content found";
    }

    // Get the LAST chunk in this turn (the actual response, not thinking)
    const lastChunk = chunksInTurn[chunksInTurn.length - 1];

    const previewText = lastChunk.textContent?.substring(0, 100) || "";
    log(`Extracting from last chunk: "${previewText}..."`);

    if (chunksInTurn.length > 1) {
      const firstPreview = chunksInTurn[0].textContent?.substring(0, 50) || "";
      log(`First chunk (thinking?): "${firstPreview}..."`);
    }

    try {
      const markdown = convertNodeToMarkdown(lastChunk);
      log("Markdown extracted successfully");
      return markdown.trim();
    } catch (e) {
      log("Markdown extraction failed: " + e);
      return "Error: Markdown extraction failed - " + e.message;
    }
  }
