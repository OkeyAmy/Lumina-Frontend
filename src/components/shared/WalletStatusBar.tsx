"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useWalletIdentity } from "@/src/hooks/useWalletIdentity";
import { flushQueue } from "@/src/lib/offlineQueue";
import { SessionIndicator } from "@/src/components/shared/SessionIndicator";

interface WaitingWorker {
  postMessage: (data: { type: "SKIP_WAITING" }) => void;
}

/**
 * WalletStatusBar is rendered once near the root of the providers tree. It
 * keeps the previously-hidden wallet status test hooks (so existing
 * Playwright tests continue to pass) and additionally exposes a small
 * visible widget showing the network status plus a service-worker update
 * prompt.
 */
export function WalletStatusBar() {
  const { publicKey, generation, isTransitioning } = useWalletIdentity();

  const [isOnline, setIsOnline] = useState(true);
  const [waitingWorker, setWaitingWorker] = useState<WaitingWorker | null>(
    null,
  );
  const flushingRef = useRef(false);
  const controllerHandlerRef = useRef<(() => void) | null>(null);

  const tryFlush = useCallback(async () => {
    if (flushingRef.current) return;
    flushingRef.current = true;
    try {
      await flushQueue();
    } finally {
      flushingRef.current = false;
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    setIsOnline(window.navigator.onLine);

    const handleOnline = () => {
      setIsOnline(true);
      void tryFlush();
    };
    const handleOffline = () => setIsOnline(false);

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);

    const handleControllerChange = () => {
      setWaitingWorker(null);
    };
    controllerHandlerRef.current = handleControllerChange;

    if ("serviceWorker" in window.navigator) {
      window.navigator.serviceWorker.addEventListener(
        "controllerchange",
        handleControllerChange,
      );

      window.navigator.serviceWorker
        .register("/sw.js", { scope: "/" })
        .then((reg) => {
          if (reg.waiting) {
            setWaitingWorker(reg.waiting as unknown as WaitingWorker);
          }
          const installing = reg.installing;
          if (!installing) return;
          installing.addEventListener("statechange", () => {
            if (
              installing.state === "installed" &&
              window.navigator.serviceWorker.controller
            ) {
              setWaitingWorker(installing as unknown as WaitingWorker);
            }
          });
        })
        .catch(() => {
          // Service worker is optional; failing to register should never
          // throw — production builds ship /sw.js, dev mode does not.
        });
    }

    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      if (
        "serviceWorker" in window.navigator &&
        controllerHandlerRef.current
      ) {
        window.navigator.serviceWorker.removeEventListener(
          "controllerchange",
          controllerHandlerRef.current,
        );
        controllerHandlerRef.current = null;
      }
    };
  }, [tryFlush]);

  const handleApplyUpdate = useCallback(() => {
    if (!waitingWorker) return;
    waitingWorker.postMessage({ type: "SKIP_WAITING" });
    if (typeof window !== "undefined") {
      window.location.reload();
    }
  }, [waitingWorker]);

  return (
    <>
      <div data-testid="wallet-status" style={{ display: "none" }}>
        <span
          data-testid="wallet-indicator"
          data-public-key={publicKey ?? "disconnected"}
        />
        <span data-testid="wallet-generation" data-generation={generation} />
        <span
          data-testid="wallet-transitioning"
          data-transitioning={isTransitioning}
        />
      </div>

      <div className="fixed right-4 top-4 z-50">
        <SessionIndicator />
      </div>

      <div
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 bottom-3 z-40 flex flex-col items-center gap-2 px-4"
      >
        {!isOnline ? (
          <div
            data-testid="offline-indicator"
            className="pointer-events-auto flex items-center gap-2 rounded-full border border-amber-300 bg-amber-100 px-4 py-1.5 text-xs font-semibold text-amber-900 shadow-sm"
          >
            <span aria-hidden className="h-2 w-2 rounded-full bg-amber-500" />
            Offline · changes will sync when connection returns
          </div>
        ) : null}

        {waitingWorker ? (
          <div
            data-testid="sw-update-prompt"
            className="pointer-events-auto flex items-center gap-3 rounded-md border border-[#cfc4b1] bg-[#171512] px-4 py-2 text-xs font-semibold text-white shadow-md"
          >
            <span>A new version of Lumina is ready.</span>
            <button
              className="rounded bg-[#0f766e] px-3 py-1 text-white transition hover:bg-[#115e59]"
              onClick={handleApplyUpdate}
              type="button"
            >
              Update
            </button>
          </div>
        ) : null}
      </div>
    </>
  );
}
