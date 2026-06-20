"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { flushSyncQueue, getSyncQueueSize } from "@/src/lib/idbClient";

export type SyncStatus = "idle" | "syncing" | "error";

export interface OfflineSyncState {
  status: SyncStatus;
  queueSize: number;
  isOnline: boolean;
  lastSyncAt: string | null;
  triggerSync: () => Promise<void>;
}

export const OfflineSyncContext = createContext<OfflineSyncState>({
  status: "idle",
  queueSize: 0,
  isOnline: true,
  lastSyncAt: null,
  triggerSync: async () => {},
});

export function useOfflineSyncContext(): OfflineSyncState {
  return useContext(OfflineSyncContext);
}

export function useOfflineSync(): OfflineSyncState {
  const [status, setStatus] = useState<SyncStatus>("idle");
  const [queueSize, setQueueSize] = useState(0);
  const [isOnline, setIsOnline] = useState(
    typeof navigator !== "undefined" ? navigator.onLine : true
  );
  const [lastSyncAt, setLastSyncAt] = useState<string | null>(null);
  const inflightRef = useRef<Promise<void> | null>(null);

  const refreshQueueSize = useCallback(async () => {
    const size = await getSyncQueueSize();
    setQueueSize(size);
  }, []);

  const runSync = useCallback(async () => {
    setStatus("syncing");
    try {
      const result = await flushSyncQueue();
      if (result.failed > 0) {
        setStatus("error");
      } else {
        setStatus("idle");
        setLastSyncAt(new Date().toISOString());
      }
    } catch {
      setStatus("error");
    } finally {
      void refreshQueueSize();
    }
  }, [refreshQueueSize]);

  const triggerSync = useCallback(async () => {
    if (typeof navigator !== "undefined" && !navigator.onLine) return;
    if (inflightRef.current) return inflightRef.current;

    const work =
      typeof requestIdleCallback !== "undefined"
        ? new Promise<void>((resolve) => {
            requestIdleCallback(() => {
              void runSync().finally(resolve);
            });
          })
        : runSync();

    inflightRef.current = work.finally(() => {
      inflightRef.current = null;
    });
    return inflightRef.current;
  }, [runSync]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    void refreshQueueSize();

    const handleOnline = () => {
      setIsOnline(true);
      void triggerSync();
    };
    const handleOffline = () => {
      setIsOnline(false);
      setStatus("idle");
    };

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    window.addEventListener("pageshow", handleOnline);

    if (navigator.onLine) {
      queueMicrotask(() => void triggerSync());
    }

    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      window.removeEventListener("pageshow", handleOnline);
    };
  }, [triggerSync, refreshQueueSize]);

  return { status, queueSize, isOnline, lastSyncAt, triggerSync };
}
