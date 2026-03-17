"use client";

import React, {
  useState,
  useEffect,
  useMemo,
  useRef,
  useCallback,
} from "react";
import styles from "./vector-debug.module.scss";

import useSWR, { preload } from "swr";
import { useChatStore } from "../store/chat";
import { useNavigate } from "react-router-dom";
import { Path } from "../constant";

// Types for API response
interface VectorRecord {
  _index: number;
  id: string;
  content: string;
  contentPreview: string;
  /** Normalised array of contributing session IDs (may be empty for very old records). */
  sessionIds: string[];
  createdAt: number;
  createdAtFormatted: string;
  keywords?: string[];
  vectorDimensions: number;
}

interface ApiResponse {
  status: "success" | "empty" | "error";
  message?: string;
  tableName?: string;
  dbPath?: string;
  stats?: {
    totalRecords: number;
    filteredCount: number;
    showingFrom: number;
    showingTo: number;
  };
  pagination?: {
    limit: number;
    offset: number;
    currentPage: number;
    totalPages: number;
    hasNextPage: boolean;
    hasPrevPage: boolean;
    nextOffset: number | null;
    prevOffset: number | null;
  };
  filters?: {
    search: string | null;
    sessionId: string | null;
  };
  availableFilters?: {
    sessionIds: string[];
  };
  records?: VectorRecord[];
}

// Fetcher function for SWR
const fetcher = (url: string) => fetch(url).then((res) => res.json());

/**
 * VectorDebug Component
 *
 * A visual interface for exploring the contents of the LanceDB vector store.
 * Features:
 * - Paginated list of all memory records
 * - Search/filter by content text
 * - Filter by session ID
 * - View full content of each record
 */
// ---------------------------------------------------------------------------
// SessionBadge — split-button that navigates to the source chat session(s)
// ---------------------------------------------------------------------------
interface SessionEntry {
  sessionId: string;
  label: string; // resolved topic or fallback
  available: boolean; // false if session no longer exists
  index: number; // position in sessions array (-1 if unavailable)
}

interface SessionBadgeProps {
  entries: SessionEntry[];
}

function SessionBadge({ entries }: SessionBadgeProps) {
  const navigate = useNavigate();
  const selectSession = useChatStore((s) => s.selectSession);
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const first = entries[0];
  const hasMultiple = entries.length > 1;

  // Close dropdown on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const goTo = useCallback(
    (entry: SessionEntry) => {
      if (!entry.available) return;
      navigate(Path.Chat);
      selectSession(entry.index);
      setOpen(false);
    },
    [navigate, selectSession],
  );

  if (!first) return null;

  return (
    <div
      ref={containerRef}
      className={`${styles["session-btn"]} ${
        hasMultiple ? styles["has-chevron"] : ""
      }`}
    >
      {/* Left: primary action — navigate to first session */}
      <button
        className={styles["session-btn-label"]}
        onClick={() => goTo(first)}
        title={
          first.available ? `Go to: ${first.label}` : "Session no longer exists"
        }
        disabled={!first.available}
      >
        📂 {first.label}
        {hasMultiple && (
          <span style={{ opacity: 0.65, marginLeft: 4, fontSize: "10px" }}>
            +{entries.length - 1}
          </span>
        )}
      </button>

      {/* Right: chevron — only shown for multi-session records */}
      {hasMultiple && (
        <button
          className={styles["session-btn-chevron"]}
          onClick={(e) => {
            e.stopPropagation();
            setOpen((v) => !v);
          }}
          title="Show all contributing sessions"
          aria-label="Show session list"
          aria-expanded={open}
        >
          {open ? "▲" : "▼"}
        </button>
      )}

      {/* Dropdown */}
      {open && (
        <div className={styles["session-dropdown"]}>
          {entries.map((entry, i) => (
            <button
              key={entry.sessionId}
              className={`${styles["session-dropdown-item"]} ${
                !entry.available ? styles["unavailable"] : ""
              }`}
              onClick={() => goTo(entry)}
              disabled={!entry.available}
              title={
                entry.available
                  ? `Go to: ${entry.label}`
                  : "Session no longer exists"
              }
            >
              <span style={{ opacity: 0.5, fontSize: "10px", flexShrink: 0 }}>
                #{i + 1}
              </span>
              {entry.label}
              {!entry.available && (
                <span
                  style={{ opacity: 0.5, fontSize: "10px", marginLeft: "auto" }}
                >
                  (deleted)
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
export function VectorDebug() {
  // Parse query params from hash URL (e.g. /#/vector-debug?q=hello&session=abc)
  const hashParams = (() => {
    const hash = window.location.hash; // e.g. "#/vector-debug?q=hello"
    const qIndex = hash.indexOf("?");
    if (qIndex === -1) return new URLSearchParams();
    return new URLSearchParams(hash.substring(qIndex));
  })();

  // Build a map of sessionId → session topic from the chat store
  const sessions = useChatStore((state) => state.sessions);
  const sessionTopicMap = useMemo(
    () => new Map(sessions.map((s) => [s.id, s.topic])),
    [sessions],
  );

  /** Label for the filter dropdown (a single raw session ID). */
  const getSessionFilterLabel = (sid: string, maxLen = 30): string => {
    const topic = sessionTopicMap.get(sid);
    if (!topic)
      return sid.length > maxLen ? `${sid.substring(0, maxLen)}…` : sid;
    return topic.length > maxLen ? `${topic.substring(0, maxLen)}…` : topic;
  };

  // State
  const [deleting, setDeleting] = useState<string | null>(null); // Track which record is being deleted

  // Initialize filter/pagination state from URL params
  const [searchQuery, setSearchQuery] = useState(hashParams.get("q") || "");
  const [sessionFilter, setSessionFilter] = useState(
    hashParams.get("session") || "",
  );
  const [limit] = useState(20);
  const [offset, setOffset] = useState(
    parseInt(hashParams.get("offset") || "0", 10),
  );

  // Expanded records (to show full content)
  const [expandedRecords, setExpandedRecords] = useState<Set<string>>(
    new Set(),
  );

  // Debounced search
  const [debouncedSearch, setDebouncedSearch] = useState(
    hashParams.get("q") || "",
  );

  // Sync URL with current filter state
  useEffect(() => {
    const params = new URLSearchParams();
    if (debouncedSearch) params.set("q", debouncedSearch);
    if (sessionFilter) params.set("session", sessionFilter);
    if (offset > 0) params.set("offset", offset.toString());

    const queryString = params.toString();
    const hashPath = queryString
      ? `#/vector-debug?${queryString}`
      : "#/vector-debug";

    // Use replaceState to avoid polluting browser history
    window.history.replaceState({}, "", hashPath);
  }, [debouncedSearch, sessionFilter, offset]);

  // Debounce search input
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(searchQuery);
      setOffset(0); // Reset to first page on new search
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  // Generate the API URL based on current state
  const getApiUrl = (
    currentLimit: number,
    currentOffset: number,
    currentSearch: string,
    currentSession: string,
  ) => {
    const params = new URLSearchParams({
      limit: currentLimit.toString(),
      offset: currentOffset.toString(),
    });

    if (currentSearch) params.set("search", currentSearch);
    if (currentSession) params.set("sessionId", currentSession);

    return `/api/vector/debug?${params.toString()}`;
  };

  const apiUrl = getApiUrl(limit, offset, debouncedSearch, sessionFilter);

  // Fetch data with SWR
  const { data, error, isLoading, isValidating, mutate } = useSWR<ApiResponse>(
    apiUrl,
    fetcher,
    {
      keepPreviousData: true,
      revalidateOnFocus: false,
    },
  );

  // Persist the last successful response so we never go blank mid-search.
  // When SWR switches to a new key (new search term), SWR's `isLoading`
  // evaluates to `true` (even with keepPreviousData), which would cause a full-page unmount.
  const lastData = useRef<ApiResponse | undefined>(undefined);
  if (data) lastData.current = data;
  const displayData = data ?? lastData.current;

  // Only show the full-page spinner on the very first ever load.
  const loading = isLoading && !lastData.current;

  // Preload helpers
  const preloadPage = (targetOffset: number) => {
    preload(
      getApiUrl(limit, targetOffset, debouncedSearch, sessionFilter),
      fetcher,
    );
  };

  // Toggle record expansion
  const toggleExpand = (recordId: string) => {
    setExpandedRecords((prev) => {
      const next = new Set(prev);
      if (next.has(recordId)) {
        next.delete(recordId);
      } else {
        next.add(recordId);
      }
      return next;
    });
  };

  // Delete a record
  const deleteRecord = async (recordId: string) => {
    if (
      !confirm(
        `Are you sure you want to delete this record?\n\nID: ${recordId}`,
      )
    ) {
      return;
    }

    setDeleting(recordId);
    try {
      const response = await fetch(
        `/api/vector/debug?id=${encodeURIComponent(recordId)}`,
        {
          method: "DELETE",
        },
      );
      const json = await response.json();

      if (json.status === "error") {
        alert(`Failed to delete: ${json.message}`);
      } else {
        // Refresh data after successful deletion
        mutate();
      }
    } catch (err) {
      alert(
        `Failed to delete: ${
          err instanceof Error ? err.message : "Unknown error"
        }`,
      );
    } finally {
      setDeleting(null);
    }
  };

  // Handle session filter change
  const handleSessionChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    setSessionFilter(e.target.value);
    setOffset(0); // Reset to first page
  };

  // Pagination handlers
  const goToNextPage = () => {
    if (data?.pagination?.nextOffset != null) {
      setOffset(data.pagination.nextOffset);
    }
  };

  const goToPrevPage = () => {
    if (data?.pagination?.prevOffset != null) {
      setOffset(data.pagination.prevOffset);
    }
  };

  // Preload on hover handlers
  const handleNextHover = () => {
    if (data?.pagination?.nextOffset != null) {
      preloadPage(data.pagination.nextOffset);
    }
  };

  const handlePrevHover = () => {
    if (data?.pagination?.prevOffset != null) {
      preloadPage(data.pagination.prevOffset);
    }
  };

  // Render loading state — only fires on the very first load (no prior data)
  if (loading) {
    return (
      <div className={styles.container}>
        <div className={styles.loading}>
          <div className={styles.spinner}></div>
        </div>
      </div>
    );
  }

  // Render error state
  if (error || displayData?.status === "error") {
    return (
      <div className={styles.container}>
        <div className={styles.header}>
          <div className={styles.title}>
            <span className={styles.icon}>🗃️</span>
            Vector Store Debug
          </div>
        </div>
        <div className={styles["error-state"]}>
          <div className={styles["error-title"]}>Error Loading Data</div>
          <div className={styles["error-message"]}>
            {error?.message || displayData?.message || "Unknown error"}
          </div>
          <button
            className={styles["refresh-btn"]}
            onClick={() => mutate()}
            style={{ marginTop: "15px" }}
          >
            Try Again
          </button>
        </div>
      </div>
    );
  }

  // Render empty state
  if (displayData?.status === "empty") {
    return (
      <div className={styles.container}>
        <div className={styles.header}>
          <div className={styles.title}>
            <span className={styles.icon}>🗃️</span>
            Vector Store Debug
          </div>
        </div>
        <div className={styles["empty-state"]}>
          <div className={styles["empty-icon"]}>📭</div>
          <div className={styles["empty-title"]}>No Data Yet</div>
          <div className={styles["empty-message"]}>
            {displayData.message ||
              "The vector store is empty. Data will appear here after conversations are processed."}
          </div>
        </div>
      </div>
    );
  }

  // Main render
  return (
    <div className={styles.container}>
      {/* Header */}
      <div className={styles.header}>
        <div className={styles.title}>
          <span className={styles.icon}>🗃️</span>
          Vector Store Debug
        </div>
        {displayData?.dbPath && (
          <code className={styles["db-path"]}>{displayData.dbPath}</code>
        )}
      </div>

      {/* Controls */}
      <div className={styles.controls}>
        <input
          type="text"
          className={styles["search-input"]}
          placeholder="Search content..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />

        <select
          className={styles["filter-select"]}
          value={sessionFilter}
          onChange={handleSessionChange}
        >
          <option value="">All Sessions</option>
          {displayData?.availableFilters?.sessionIds.map((sid) => (
            <option key={sid} value={sid}>
              {getSessionFilterLabel(sid, 30)}
            </option>
          ))}
        </select>

        <button
          className={styles["refresh-btn"]}
          onClick={() => mutate()}
          disabled={isValidating}
        >
          {isValidating ? "Loading..." : "🔄 Refresh"}
        </button>
      </div>

      {/* Stats Bar */}
      {displayData?.stats && (
        <div className={styles["stats-bar"]}>
          <div className={styles.stat}>
            <div className={styles["stat-label"]}>Total Records</div>
            <div className={styles["stat-value"]}>
              {displayData.stats.totalRecords}
            </div>
          </div>
          <div className={styles.stat}>
            <div className={styles["stat-label"]}>Filtered</div>
            <div className={styles["stat-value"]}>
              {displayData.stats.filteredCount}
            </div>
          </div>
          <div className={styles.stat}>
            <div className={styles["stat-label"]}>Showing</div>
            <div className={styles["stat-value"]}>
              {displayData.stats.showingFrom}-{displayData.stats.showingTo}
            </div>
          </div>
        </div>
      )}

      {/* Records List */}
      {displayData?.records && displayData.records.length > 0 ? (
        <div className={styles["records-list"]}>
          {displayData.records.map((record) => {
            const isExpanded = expandedRecords.has(record.id);
            const hasFullContent = record.content !== record.contentPreview;

            return (
              <div key={record.id} className={styles["record-card"]}>
                <div className={styles["record-header"]}>
                  <div className={styles["record-meta"]}>
                    <span className={styles["record-index"]}>
                      #{record._index + 1}
                    </span>
                    <span className={styles["record-id"]} title={record.id}>
                      {record.id}
                    </span>
                    <span className={styles["record-date"]}>
                      {record.createdAtFormatted}
                    </span>
                  </div>
                  <div className={styles["record-badges"]}>
                    {/* Split-button session badge */}
                    {(() => {
                      const ids =
                        record.sessionIds && record.sessionIds.length > 0
                          ? record.sessionIds
                          : [record.id];
                      const entries: SessionEntry[] = ids.map((sid) => {
                        const topic = sessionTopicMap.get(sid);
                        const idx = sessions.findIndex((s) => s.id === sid);
                        return {
                          sessionId: sid,
                          label: topic ?? `Unknown (${sid.substring(0, 8)}…)`,
                          available: idx !== -1,
                          index: idx,
                        };
                      });
                      return <SessionBadge entries={entries} />;
                    })()}
                    <span className={`${styles.badge} ${styles.vector}`}>
                      {record.vectorDimensions}D
                    </span>
                    <button
                      className={styles["delete-btn"]}
                      onClick={() => deleteRecord(record.id)}
                      disabled={deleting === record.id}
                      title="Delete this record"
                    >
                      {deleting === record.id ? "..." : "🗑️"}
                    </button>
                  </div>
                </div>

                <div className={styles["record-body"]}>
                  <div className={styles["record-content"]}>
                    {isExpanded ? record.content : record.contentPreview}
                  </div>

                  {record.keywords && record.keywords.length > 0 && (
                    <div className={styles["record-keywords"]}>
                      {record.keywords.map((kw, i) => (
                        <span key={i} className={styles.keyword}>
                          {kw}
                        </span>
                      ))}
                    </div>
                  )}
                </div>

                {hasFullContent && (
                  <button
                    className={styles["record-expand-toggle"]}
                    onClick={() => toggleExpand(record.id)}
                  >
                    {isExpanded ? "▲ Show Less" : "▼ Show Full Content"}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <div className={styles["empty-state"]}>
          <div className={styles["empty-icon"]}>🔍</div>
          <div className={styles["empty-title"]}>No Results</div>
          <div className={styles["empty-message"]}>
            {searchQuery ? (
              <>
                No records found for <strong>&quot;{searchQuery}&quot;</strong>.
                Try adjusting your search or session filter.
              </>
            ) : (
              "No records match your current filters. Try adjusting your search or session filter."
            )}
          </div>
        </div>
      )}

      {/* Pagination */}
      {displayData?.pagination && displayData.pagination.totalPages > 1 && (
        <div className={styles.pagination}>
          <button
            className={styles["page-btn"]}
            onClick={goToPrevPage}
            onMouseEnter={handlePrevHover}
            disabled={!displayData.pagination.hasPrevPage || isLoading}
          >
            ← Previous
          </button>

          <span className={styles["page-info"]}>
            Page{" "}
            <span className={styles["current-page"]}>
              {displayData.pagination.currentPage}
            </span>{" "}
            of {displayData.pagination.totalPages}
          </span>

          <button
            className={styles["page-btn"]}
            onClick={goToNextPage}
            onMouseEnter={handleNextHover}
            disabled={!displayData.pagination.hasNextPage || isLoading}
          >
            Next →
          </button>
        </div>
      )}
    </div>
  );
}

export default VectorDebug;
