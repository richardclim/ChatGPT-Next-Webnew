import { StateStorage } from "zustand/middleware";
import { get, set, del, clear } from "idb-keyval";
import { safeLocalStorage } from "@/app/utils";

const localStorage = safeLocalStorage();

// ---- Tab identity -----------------------------------------------------------
const TAB_ID_KEY = "chat_tab_id";
const TAB_ID = (() => {
  try {
    const v =
      sessionStorage.getItem(TAB_ID_KEY) ||
      crypto.randomUUID?.() ||
      Math.random().toString(36).slice(2);
    sessionStorage.setItem(TAB_ID_KEY, v);
    return v;
  } catch {
    // SSR or locked sessionStorage
    return Math.random().toString(36).slice(2);
  }
})();

// ---- A generic wrapper to hold the app's state along with metadata ----------------------------
export type PersistEnvelope = {
  state: any;
  version: number;
  rev?: number;
  updatedAt?: number;
  writer?: string;
};

// ---- BroadcastChannel per key -----------------------------------------------
const channels: Record<string, BroadcastChannel | null> = {};
function getBC(name: string): BroadcastChannel | null {
  if (typeof window === "undefined") return null;
  if (!("BroadcastChannel" in window)) return null;
  if (!channels[name]) {
    channels[name] = new BroadcastChannel(`${name}:bc`);
  }
  return channels[name];
}

// ---- Fallback "storage" ping for tabs without BC ----------------------------
function pingStorage(name: string, data: any) {
  try {
    localStorage.setItem(
      `${name}:ping`,
      JSON.stringify({ ...data, ts: Date.now() }),
    );
  } catch {}
}

// ---- Web Locks API / fallback advisory lock --------------------------------
async function withPersistLock<T>(
  name: string,
  fn: () => Promise<T>,
): Promise<T> {
  const lockName = `${name}:persist`;
  const nav: any = typeof navigator !== "undefined" ? navigator : undefined;

  if (nav?.locks?.request) {
    return nav.locks.request(lockName, { mode: "exclusive" }, fn);
  }

  // Fallback: advisory lock using localStorage with TTL/backoff
  const lockKey = `${lockName}:lock`;
  const ttl = 2500; // ms
  const backoff = () =>
    new Promise((r) => setTimeout(r, 50 + Math.random() * 50));
  while (true) {
    const now = Date.now();
    const raw = localStorage.getItem(lockKey);
    const cur = raw ? Number(raw) : 0;
    // checks to see if the lock can be acquired.
    // "now - cur" if lockKey is in localStorage, is a way to get the total time since setItem was called.
    if (!cur || now - cur > ttl) {
      try {
        localStorage.setItem(lockKey, String(now));
        // we "acquired" the lock and execute the fn()
        const res = await fn();
        localStorage.removeItem(lockKey);
        return res;
      } catch (e) {
        localStorage.removeItem(lockKey);
        throw e;
      }
    }
    await backoff();
  }
}

// ---- Debounced write queue per key ------------------------------------------
const pending: Record<string, { timer: number | null; value: string | null }> =
  {};

async function performSetItem(name: string, value: string): Promise<void> {
  // inside here we actually do the write (locked)
  await withPersistLock(name, async () => {
    // read current envelope
    let oldRaw: string | null = null;
    try {
      oldRaw = (await get(name)) || localStorage.getItem(name);
    } catch {
      oldRaw = localStorage.getItem(name);
    }

    // parse incoming value
    let incoming: PersistEnvelope;
    try {
      incoming = JSON.parse(value);
    } catch {
      // if it somehow isn't JSON, just store as-is
      await set(name, value);
      return;
    }

    // if store isn't hydrated yet, skip persistence
    if (!incoming?.state?._hasHydrated) {
      console.warn("skip setItem (not hydrated):", name);
      return;
    }

    // determine previous rev
    let prevRev = 0;
    let prevStateString = "";
    if (oldRaw) {
      try {
        const prevEnvelope = JSON.parse(oldRaw) as PersistEnvelope;
        prevRev = Number(prevEnvelope?.rev || 0);
        prevStateString = JSON.stringify(prevEnvelope?.state ?? {});
      } catch {}
    }

    // If the persisted state (after partialize) didn't change, skip write.
    // This protects from writing on every streaming tick (we partialize streaming away).
    const nextStateString = JSON.stringify(incoming.state ?? {});
    if (prevStateString === nextStateString) {
      return;
    }

    // build new envelope with incremented rev
    const newEnvelope: PersistEnvelope = {
      ...incoming,
      rev: prevRev + 1,
      updatedAt: Date.now(),
      writer: TAB_ID,
    };

    const payload = JSON.stringify(newEnvelope);

    try {
      await set(name, payload);
    } catch {
      localStorage.setItem(name, payload);
    }

    // Notify other tabs
    const bc = getBC(name);
    const msg = {
      type: "persisted",
      key: name,
      rev: newEnvelope.rev,
      from: TAB_ID,
    };
    if (bc) {
      bc.postMessage(msg);
    } else {
      pingStorage(name, msg);
    }
  });
}

class IndexedDBStorage implements StateStorage {
  public async getItem(name: string): Promise<string | null> {
    console.log(`[IndexedDBStorage] getItem called for: ${name}`);
    try {
      const value = (await get(name)) || localStorage.getItem(name);
      console.log(
        `[IndexedDBStorage] getItem completed for: ${name}, hasValue: ${!!value}`,
      );
      return value;
    } catch (error) {
      console.log(`[IndexedDBStorage] getItem error for: ${name}`, error);
      return localStorage.getItem(name);
    }
  }

  public async setItem(name: string, value: string): Promise<void> {
    // debounce writes per key to reduce thrash during rapid updates
    if (!pending[name]) {
      pending[name] = { timer: null, value: null };
    }
    pending[name].value = value;
    if (pending[name].timer) {
      clearTimeout(pending[name].timer!);
    }

    await new Promise<void>((resolve) => {
      pending[name].timer = window.setTimeout(async () => {
        const v = pending[name].value!;
        pending[name].timer = null;
        pending[name].value = null;
        try {
          await performSetItem(name, v);
        } finally {
          resolve();
        }
      }, 250);
    });
  }

  public async removeItem(name: string): Promise<void> {
    try {
      await del(name);
    } catch (error) {
      localStorage.removeItem(name);
    }
  }

  public async clear(): Promise<void> {
    try {
      await clear();
    } catch (error) {
      localStorage.clear();
    }
  }
}

export const indexedDBStorage = new IndexedDBStorage();

// Helper (reader function) so stores can read rev, writer, updatedAt
export async function readPersistEnvelope(
  name: string,
): Promise<PersistEnvelope | null> {
  try {
    const raw = (await get(name)) || localStorage.getItem(name);
    return raw ? (JSON.parse(raw) as PersistEnvelope) : null;
  } catch {
    const raw = localStorage.getItem(name);
    return raw ? (JSON.parse(raw) as PersistEnvelope) : null;
  }
}

// Helper to subscribe to localStorage ping fallback
export function attachStoragePingListener(
  name: string,
  onPing: (data: any) => void,
) {
  window.addEventListener("storage", (e) => {
    if (e.key === `${name}:ping` && e.newValue) {
      try {
        const data = JSON.parse(e.newValue);
        onPing(data);
      } catch {}
    }
  });
}
