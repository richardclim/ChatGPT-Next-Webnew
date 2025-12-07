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
    TITLE_ELEMENT: "h1.mode-title",
    SCROLL_CONTAINER: "ms-autoscroll-container",
  };

  const SCROLL_CONFIG = {
    STABILIZATION_CHECK_INTERVAL: 100, // ms between height checks
    STABILIZATION_TIMEOUT: 3000, // max time to wait for stabilization
    POST_SCROLL_DELAY: 500, // delay after scroll before extraction
  };
  let isProcessing = false;

  function log(msg) {
    console.log("[Bridge]", msg);
  }

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
   * Waits for content height to stabilize, indicating rendering is complete.
   * @param {Element} container - The scroll container element
   * @param {number} timeout - Maximum time to wait in ms
   * @returns {Promise<void>}
   */
  function waitForContentStabilization(
    container,
    timeout = SCROLL_CONFIG.STABILIZATION_TIMEOUT,
  ) {
    return new Promise((resolve) => {
      const startTime = Date.now();
      let lastHeight = container.scrollHeight;
      let consecutiveStableChecks = 0;

      const checkInterval = setInterval(() => {
        const currentHeight = container.scrollHeight;

        if (currentHeight === lastHeight) {
          consecutiveStableChecks++;
          if (consecutiveStableChecks >= 2) {
            clearInterval(checkInterval);
            resolve();
            return;
          }
        } else {
          consecutiveStableChecks = 0;
          lastHeight = currentHeight;
        }

        if (Date.now() - startTime >= timeout) {
          clearInterval(checkInterval);
          log("Content stabilization timeout, proceeding with extraction");
          resolve();
        }
      }, SCROLL_CONFIG.STABILIZATION_CHECK_INTERVAL);
    });
  }

  /**
   * Scrolls the chat container to the bottom to trigger content propagation.
   * @returns {Promise<boolean>} - True if scroll was successful, false otherwise
   */
  async function scrollToBottom() {
    try {
      // Log background tab status if running in background
      if (document.hidden) {
        log("Running in background tab");
      }

      // Find the scroll container
      const container = findScrollContainer();
      if (!container) {
        log("Scroll container not found, proceeding with extraction");
        return false;
      }

      // Scroll to bottom
      container.scrollTop = container.scrollHeight;

      // Wait for content to stabilize after scrolling
      await waitForContentStabilization(container);

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
    const input = document.querySelector(SELECTORS.INPUT_BOX);
    if (input) {
      input.value = request.content;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await wait(500);
      click(SELECTORS.SUBMIT_BUTTON);
      await waitForGeneration();
      await scrollToBottom();
      await wait(SCROLL_CONFIG.POST_SCROLL_DELAY);
      const responseText = extractMarkdown();
      const title = request.isNewChat ? extractTitle() : null;
      sendResponse(request.id, responseText, title);
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
    await new Promise((resolve) => {
      const check = setInterval(() => {
        const stopBtn = document.querySelector(SELECTORS.STOP_BUTTON);
        if (!stopBtn) {
          clearInterval(check);
          resolve();
        }
      }, 1000);
    });
    await wait(1500);
    log("Generation complete, content should be fully rendered");
  }

  function extractMarkdown() {
    log("Extracting markdown from DOM...");
    const response = document.querySelectorAll(SELECTORS.RESPONSE);
    const lastResponse = response[response.length - 1];
    if (!lastResponse) {
      return "Error: No response elements found";
    }

    try {
      // Manual markdown extraction to avoid Trusted Types issues
      const markdown = convertNodeToMarkdown(lastResponse);
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
})();
