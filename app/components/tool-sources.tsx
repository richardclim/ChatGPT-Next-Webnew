import React, { useState, useMemo } from "react";
import styles from "./tool-sources.module.scss";
import { ChatMessageTool } from "../store";

function SearchIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      width="18"
      height="18"
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M10.5 10.5L14 14"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
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

interface SourceResult {
  url: string;
  title: string;
  content: string;
}

const INITIAL_SOURCE_LIMIT = 20;

function stripWww(hostname: string): string {
  return hostname.replace(/^www\./, "");
}

export function ToolSources({ tools }: { tools: ChatMessageTool[] }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [showAllSources, setShowAllSources] = useState(false);
  const [activeSnippet, setActiveSnippet] = useState<string | null>(null);

  const tavilyTools = tools.filter(
    (t) =>
      t.function?.name === "tavily_search" ||
      t.function?.name === "tavily_retrieve",
  );

  const hasSearch = tavilyTools.some(
    (t) => t.function?.name === "tavily_search",
  );
  const hasRetrieve = tavilyTools.some(
    (t) => t.function?.name === "tavily_retrieve",
  );
  const isRetrieveOnly = hasRetrieve && !hasSearch;

  const isSearching = tavilyTools.some(
    (t) => t.function?.name === "tavily_search" && !t.content && !t.isError,
  );
  const isRecalling = tavilyTools.some(
    (t) => t.function?.name === "tavily_retrieve" && !t.content && !t.isError,
  );
  const hasError = tavilyTools.some((t) => t.isError);
  const isActive = isSearching || isRecalling;

  const toolsDeps = JSON.stringify(
    tavilyTools.map((t) => ({
      args: t.function?.arguments,
      content: t.content,
      isError: t.isError,
    })),
  );

  const { queries, uniqueSources } = useMemo(() => {
    const queries: string[] = [];
    const sources: SourceResult[] = [];

    tavilyTools.forEach((t) => {
      if (t.function?.arguments) {
        try {
          const args = JSON.parse(t.function.arguments);
          if (args.queries && Array.isArray(args.queries)) {
            queries.push(...args.queries);
          }
        } catch (_e) {
          /* malformed args */
        }
      }

      if (t.content && !t.isError) {
        try {
          let contentData = JSON.parse(t.content);
          if (typeof contentData === "string") {
            try {
              contentData = JSON.parse(contentData);
            } catch {
              /* not double-encoded */
            }
          }

          if (Array.isArray(contentData)) {
            if (contentData.length > 0 && contentData[0].function) {
              contentData.forEach((archivedTool: { content?: string }) => {
                if (archivedTool.content) {
                  try {
                    const archivedData = JSON.parse(archivedTool.content);
                    if (Array.isArray(archivedData)) {
                      sources.push(...archivedData);
                    }
                  } catch (_e) {
                    /* malformed archived content */
                  }
                }
              });
            } else {
              sources.push(...contentData);
            }
          } else if (contentData && Array.isArray(contentData.results)) {
            sources.push(...contentData.results);
          }
        } catch (_e) {
          /* malformed content */
        }
      }
    });

    const sourcesMap = new Map<string, SourceResult>();
    sources.forEach((s) => {
      if (!s || !s.url) return;
      let cleanUrl = s.url;
      try {
        const parsed = new URL(s.url);
        parsed.hash = "";
        cleanUrl = parsed.toString();
      } catch (_e) {
        /* invalid url */
      }

      const existing = sourcesMap.get(cleanUrl);
      if (existing) {
        if (
          s.content &&
          existing.content &&
          !existing.content.includes(s.content)
        ) {
          existing.content = `${existing.content} ... ${s.content}`;
        } else if (s.content && !existing.content) {
          existing.content = s.content;
        }
      } else {
        sourcesMap.set(cleanUrl, { ...s });
      }
    });

    return {
      queries: Array.from(new Set(queries)),
      uniqueSources: Array.from(sourcesMap.values()).filter(
        (s) => s.title && s.url,
      ),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toolsDeps]);

  if (tavilyTools.length === 0) return null;

  const getLabel = (): string => {
    if (isRecalling) return "Recalling from memory...";
    if (isSearching) return "Searching...";
    if (isRetrieveOnly) return "Recalled earlier sources";
    if (hasError) return "Partial results retrieved";
    if (uniqueSources.length > 0)
      return `Reviewed ${uniqueSources.length} sources`;
    return "Reviewed sources";
  };

  const truncate = (text: string, max: number): string => {
    if (!text) return "";
    return text.length > max ? text.slice(0, max) + "..." : text;
  };

  // Retrieve-only: passive pill, no expand
  if (isRetrieveOnly && !isActive) {
    return (
      <div className={styles["tool-sources"]}>
        <div className={styles["sources-pill"]}>
          <SearchIcon className={styles["search-icon"]} />
          <span className={styles["pill-label"]}>{getLabel()}</span>
        </div>
      </div>
    );
  }

  return (
    <div className={styles["tool-sources"]}>
      <div
        className={styles["sources-pill"]}
        onClick={() => setIsExpanded((prev) => !prev)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setIsExpanded((prev) => !prev);
          }
        }}
      >
        <SearchIcon
          className={`${styles["search-icon"]} ${
            isActive ? styles["pulse"] : ""
          }`}
        />
        <span
          className={`${styles["pill-label"]} ${
            isActive ? styles["shimmer"] : ""
          }`}
        >
          {getLabel()}
        </span>
        {!isActive && (
          <ChevronIcon
            className={`${styles["chevron-icon"]} ${
              isExpanded ? styles["chevron-expanded"] : ""
            }`}
          />
        )}
      </div>

      <div
        className={`${styles["sources-content"]} ${
          isExpanded ? styles["expanded"] : ""
        }`}
      >
        <div className={styles["sources-content-inner"]}>
          {hasRetrieve && (
            <div className={styles["recall-note"]}>
              Also recalled sources from earlier in conversation
            </div>
          )}
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
            <div className={styles["links-section"]}>
              <div className={styles["section-title"]}>Sources</div>
              <div className={styles["sources-grid"]}>
                {(showAllSources
                  ? uniqueSources
                  : uniqueSources.slice(0, INITIAL_SOURCE_LIMIT)
                ).map((source) => {
                  let hostname = "";
                  try {
                    hostname = stripWww(new URL(source.url).hostname);
                  } catch (_e) {
                    /* invalid url */
                  }
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
                          rel="noopener noreferrer"
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
                        <div className={styles["snippet-btn-container"]}>
                          <div
                            className={`${styles["snippet-btn"]} ${
                              activeSnippet === source.url
                                ? styles["active"]
                                : ""
                            }`}
                            onMouseEnter={() => setActiveSnippet(source.url)}
                            onMouseLeave={() => setActiveSnippet(null)}
                            onClick={(e) => {
                              e.stopPropagation();
                              setActiveSnippet(
                                activeSnippet === source.url
                                  ? null
                                  : source.url,
                              );
                            }}
                          >
                            i
                            {activeSnippet === source.url && (
                              <div className={styles["snippet-tooltip"]}>
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
              {!showAllSources &&
                uniqueSources.length > INITIAL_SOURCE_LIMIT && (
                  <div
                    className={styles["show-more"]}
                    onClick={() => setShowAllSources(true)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setShowAllSources(true);
                      }
                    }}
                  >
                    +{uniqueSources.length - INITIAL_SOURCE_LIMIT} more
                  </div>
                )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
