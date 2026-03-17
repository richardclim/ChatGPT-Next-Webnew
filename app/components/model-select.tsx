import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import DownIcon from "../icons/down.svg";
import styles from "./model-select.module.scss";
import type { LLMModelProvider } from "../client/api";

export interface ModelItem {
  name: string;
  displayName?: string;
  available: boolean;
  sorted: number;
  provider?: LLMModelProvider;
  isDefault?: boolean;
}

export interface GroupedModels {
  [provider: string]: ModelItem[];
}

interface ModelSelectProps {
  value: string;
  models: GroupedModels;
  onChange: (value: string) => void;
  "aria-label"?: string;
  placeholder?: string;
}

export function ModelSelect(props: ModelSelectProps) {
  const { value, models, onChange, placeholder } = props;
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Find display name for current value
  const displayLabel = useMemo(() => {
    for (const provider of Object.keys(models)) {
      const found = models[provider].find(
        (m) => `${m.name}@${m.provider?.providerName}` === value,
      );
      if (found) return found.displayName ?? found.name;
    }
    return placeholder ?? "Select model";
  }, [value, models, placeholder]);

  // Filter models by search
  const filtered = useMemo(() => {
    if (!search.trim()) return models;
    const q = search.toLowerCase();
    const result: GroupedModels = {};
    for (const provider of Object.keys(models)) {
      const matches = models[provider].filter(
        (m) =>
          (m.displayName ?? m.name).toLowerCase().includes(q) ||
          m.name.toLowerCase().includes(q) ||
          provider.toLowerCase().includes(q),
      );
      if (matches.length > 0) result[provider] = matches;
    }
    return result;
  }, [models, search]);

  // Position popover relative to trigger
  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current;
    const popover = popoverRef.current;
    if (!trigger || !popover) return;

    const rect = trigger.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom;
    const popoverHeight = Math.min(400, spaceBelow - 10);

    if (spaceBelow > 200) {
      popover.style.top = `${rect.bottom + 4}px`;
      popover.style.maxHeight = `${popoverHeight}px`;
    } else {
      popover.style.bottom = `${window.innerHeight - rect.top + 4}px`;
      popover.style.top = "auto";
      popover.style.maxHeight = `${rect.top - 10}px`;
    }

    popover.style.left = `${rect.left}px`;
    popover.style.width = `${rect.width}px`;
  }, []);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (
        popoverRef.current &&
        !popoverRef.current.contains(e.target as Node) &&
        triggerRef.current &&
        !triggerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
        setSearch("");
      }
    };
    document.addEventListener("mousedown", handler as any);
    return () => document.removeEventListener("mousedown", handler as any);
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        setSearch("");
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open]);

  // Close on ancestor scroll so popover doesn't float away
  useEffect(() => {
    if (!open) return;
    const handler = (e: Event) => {
      // Ignore scrolling inside the popover itself (the model list)
      if (popoverRef.current?.contains(e.target as Node)) return;
      setOpen(false);
      setSearch("");
    };
    document.addEventListener("scroll", handler, true);
    return () => document.removeEventListener("scroll", handler, true);
  }, [open]);

  // Position, focus, and scroll to selected on open
  useEffect(() => {
    if (open) {
      requestAnimationFrame(() => {
        updatePosition();
        searchRef.current?.focus();

        // Scroll selected item to center of list
        const list = listRef.current;
        if (list) {
          const selected = list.querySelector(
            `[aria-selected="true"]`,
          ) as HTMLElement | null;
          if (selected) {
            const listHeight = list.clientHeight;
            const selectedTop = selected.offsetTop;
            const selectedHeight = selected.offsetHeight;
            list.scrollTop = selectedTop - listHeight / 2 + selectedHeight / 2;
          }
        }
      });
    }
  }, [open, updatePosition]);

  const handleSelect = useCallback(
    (val: string) => {
      onChange(val);
      setOpen(false);
      setSearch("");
      triggerRef.current?.focus();
    },
    [onChange],
  );

  return (
    <div className={styles["model-select"]}>
      <button
        ref={triggerRef}
        className={styles["model-select-trigger"]}
        aria-label={props["aria-label"]}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        type="button"
      >
        {displayLabel}
      </button>
      <DownIcon className={styles["model-select-icon"]} />

      {open && (
        <div ref={popoverRef} className={styles["model-select-popover"]}>
          <div className={styles["model-select-search"]}>
            <input
              ref={searchRef}
              type="text"
              placeholder="Search models..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div
            ref={listRef}
            className={styles["model-select-list"]}
            role="listbox"
          >
            {Object.keys(filtered).length === 0 ? (
              <div className={styles["model-select-empty"]}>
                No models found
              </div>
            ) : (
              Object.keys(filtered).map((provider) => (
                <div key={provider}>
                  <div className={styles["model-select-group-header"]}>
                    {provider}
                  </div>
                  {filtered[provider].map((m) => {
                    const optVal = `${m.name}@${m.provider?.providerName}`;
                    return (
                      <div
                        key={optVal}
                        role="option"
                        aria-selected={optVal === value}
                        className={`${styles["model-select-option"]}${
                          optVal === value ? ` ${styles["selected"]}` : ""
                        }`}
                        onClick={() => handleSelect(optVal)}
                      >
                        {m.displayName ?? m.name}
                      </div>
                    );
                  })}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
