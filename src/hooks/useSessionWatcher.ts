"use client";

import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useWalletIdentity } from "@/src/hooks/useWalletIdentity";
import {
  SessionWatcher,
  SessionState,
} from "@/src/services/sessionWatcher";
import { getSharedStateSync } from "@/src/services/sharedStateSync";

export function useSessionWatcher() {
  const { publicKey } = useWalletIdentity();
  const queryClient = useQueryClient();
  const [sessionState, setSessionState] = useState<SessionState>(SessionState.ACTIVE);
  const watcherRef = useRef<SessionWatcher | null>(null);

  useEffect(() => {
    const watcher = new SessionWatcher({
      onStateChange: (state) => {
        setSessionState(state);

        if (
          state === SessionState.WALLET_DISCONNECTED ||
          state === SessionState.IDLE_LOCKED
        ) {
          try {
            getSharedStateSync().publish("auth_expire", {
              reason:
                state === SessionState.IDLE_LOCKED
                  ? "idle_timeout"
                  : "wallet_disconnected",
            });
          } catch {
            // shared state sync not available
          }
        }
      },
      onLogout: () => {
        queryClient.clear();
      },
    });

    watcherRef.current = watcher;

    return () => {
      watcher.stop();
      watcherRef.current = null;
    };
  }, [queryClient]);

  useEffect(() => {
    if (watcherRef.current) {
      watcherRef.current.updatePublicKey(publicKey);
    }
  }, [publicKey]);

  return { sessionState };
}
