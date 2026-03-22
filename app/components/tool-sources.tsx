import React, { useState, useMemo } from "react";
import styles from "./tool-sources.module.scss";
import { ChatMessageTool } from "../store";

function ChevronIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      width="1em"
      height="1em"
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

interface SourceResult {
  url: string;
  title: string;
  content: string;
}

export function ToolSources({ tools }: { tools: ChatMessageTool[] }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [activeSnippet, setActiveSnippet] = useState<string | null>(null);

  const tavilyTools = tools.filter(
    (t) =>
      t.function?.name === "tavily_search" ||
      t.function?.name === "tavily_retrieve",
  );

  const isSearching = tavilyTools.some((t) => !t.content && !t.isError);
  const isRecalling = tavilyTools.some(
    (t) => t.function?.name === "tavily_retrieve" && !t.content && !t.isError,
  );
  const hasError = tavilyTools.some((t) => t.isError);

  // Serialize exactly what matters to avoid parent re-reference triggering re-renders
  const toolsDeps = JSON.stringify(
    tavilyTools.map((t) => ({
      args: t.function?.arguments,
      content: t.content,
      isError: t.isError,
    })),
  );

  const { queries, uniqueSources } = useMemo(() => {
    let queries: string[] = [];
    let sources: SourceResult[] = [];

    tavilyTools.forEach((t) => {
      // extract queries
      if (t.function?.arguments) {
        try {
          const args = JSON.parse(t.function.arguments);
          if (args.queries && Array.isArray(args.queries)) {
            queries.push(...args.queries);
          } else if (args.turn_id) {
            queries.push(`Turn ID: ${args.turn_id}`);
          }
        } catch (e) {}
      }

      // extract sources
      if (t.content && !t.isError) {
        try {
          let contentData = JSON.parse(t.content);
          if (typeof contentData === "string") {
            try {
              contentData = JSON.parse(contentData);
            } catch {}
          }

          // tavily_search returns an array of results
          if (Array.isArray(contentData)) {
            // It could be the retrieve payload (nested historical tools), which is an array of tools
            if (contentData.length > 0 && contentData[0].function) {
              // this is a retrieve payload (tool array)
              contentData.forEach((archivedTool) => {
                if (archivedTool.content) {
                  try {
                    const archivedData = JSON.parse(archivedTool.content);
                    if (Array.isArray(archivedData)) {
                      sources.push(...archivedData);
                    }
                  } catch (e) {}
                }
              });
            } else {
              sources.push(...contentData);
            }
          } else if (contentData && Array.isArray(contentData.results)) {
            sources.push(...contentData.results);
          }
        } catch (e) {}
      }
    });

    // Group by URL to ensure we don't lose any extracted snippets
    const sourcesMap = new Map<string, SourceResult>();

    sources.forEach((s) => {
      if (!s || !s.url) return;

      // Normalize URL for grouping
      let cleanUrl = s.url;
      try {
        const parsed = new URL(s.url);
        parsed.hash = ""; // Remove anchors
        cleanUrl = parsed.toString();
      } catch (e) {}

      const existing = sourcesMap.get(cleanUrl);

      if (existing) {
        // If we already have this URL but with a different snippet, safely merge the contents
        // This is crucial because different queries might extract different parts of the same page
        if (
          s.content &&
          existing.content &&
          !existing.content.includes(s.content)
        ) {
          // Combine snippets with an ellipsis separator
          existing.content = `${existing.content} ... ${s.content}`;
        } else if (s.content && !existing.content) {
          existing.content = s.content;
        }
      } else {
        sourcesMap.set(cleanUrl, { ...s });
      }
    });

    const uniqueSources = Array.from(sourcesMap.values()).filter(
      (s) => s.title && s.url,
    );
    const uniqueQueries = Array.from(new Set(queries));

    return { queries: uniqueQueries, uniqueSources };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toolsDeps]);

  if (tavilyTools.length === 0) return null;

  const getLabel = () => {
    if (isRecalling) return "Recalling from memory...";
    if (isSearching) return "Searching...";
    if (hasError) return "Partial results retrieved";
    if (uniqueSources.length > 0)
      return `Reviewed ${uniqueSources.length} sources`;
    return "Reviewed sources";
  };

  const truncate = (text: string, max: number) => {
    if (!text) return "";
    return text.length > max ? text.slice(0, max) + "..." : text;
  };

  return (
    <div className={styles["tool-sources"]}>
      <div
        className={styles["tool-sources-header"]}
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <div className={styles["header-left"]}>
          {hasError ? (
            <span className={styles["status-icon"]}>⚠️</span>
          ) : isSearching ? (
            <div className={styles["status-spinner"]} />
          ) : (
            <span className={styles["status-icon"]}>✓</span>
          )}
          <span className={styles["tool-sources-label"]}>{getLabel()}</span>
        </div>
        <ChevronIcon
          className={`${styles["chevron"]} ${
            isExpanded ? styles["expanded"] : ""
          }`}
        />
      </div>

      {isExpanded && (
        <div className={styles["tool-sources-content"]}>
          {queries.length > 0 && (
            <div className={styles["queries-section"]}>
              <div className={styles["section-title"]}>Searches</div>
              <div className={styles["queries-list"]}>
                {queries.map((q) => (
                  <div key={q} className={styles["query-pill"]}>
                    {q}
                  </div>
                ))}
              </div>
            </div>
          )}

          {uniqueSources.length > 0 && (
            <div className={styles["sources-section"]}>
              <div className={styles["section-title"]}>Sources</div>
              <div className={styles["sources-grid"]}>
                {uniqueSources.map((source) => {
                  let hostname = "";
                  try {
                    hostname = new URL(source.url).hostname;
                  } catch (e) {}
                  return (
                    <div key={source.url} className={styles["source-item"]}>
                      {hostname && (
                        <img
                          className={styles["favicon"]}
                          src={`https://www.google.com/s2/favicons?domain=${hostname}&sz=32`}
                          alt=""
                          onError={(e) => {
                            e.currentTarget.style.display = "none";
                          }}
                        />
                      )}
                      <div className={styles["source-info"]}>
                        <a
                          href={source.url}
                          target="_blank"
                          title={source.title}
                          className={styles["source-title"]}
                        >
                          {source.title || hostname || source.url}
                        </a>
                        <div className={styles["source-domain"]}>
                          {hostname}
                        </div>
                      </div>
                      {source.content && (
                        <div className={styles["source-info-btn-container"]}>
                          <div
                            className={`${styles["source-info-btn"]} ${
                              activeSnippet === source.url
                                ? styles["active"]
                                : ""
                            }`}
                            onMouseEnter={() => setActiveSnippet(source.url)}
                            onMouseLeave={() => setActiveSnippet(null)}
                            onClick={(e) => {
                              e.preventDefault();
                              setActiveSnippet(
                                activeSnippet === source.url
                                  ? null
                                  : source.url,
                              );
                            }}
                          >
                            i
                            {activeSnippet === source.url && (
                              <div className={styles["source-tooltip"]}>
                                {truncate(source.content, 2000)}
                              </div>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
