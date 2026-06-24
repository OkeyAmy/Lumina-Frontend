"use client";

import { QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { createQueryClient } from "@/src/lib/queryClient";
import { installOfflineSync } from "@/src/lib/offlineSync";
import { WalletProvider } from "@/src/components/providers/WalletProvider";
import { SessionProvider } from "@/src/components/providers/SessionProvider";
import { WalletStatusBar } from "@/src/components/shared/WalletStatusBar";
import { ThemeProvider } from "@/src/components/providers/ThemeProvider";
import { useOfflineSync, OfflineSyncContext } from "@/src/hooks/useOfflineSync";
import { useSharedStateQuerySync } from "@/src/hooks/useSharedStateQuerySync";
import { useNetworkStatus } from "@/src/hooks/useNetworkStatus";
import {
  noteConnectivityRestored,
  processOfflineQueue,
} from "@/src/lib/sentry/sentryClient";
import { AppErrorBoundary } from "@/src/components/error/AppErrorBoundary";

function RequestQueueInstigator() {
  useEffect(() => installOfflineSync(), []);
  return null;
}

function SharedStateQueryBridge() {
  useSharedStateQuerySync();
  return null;
}

function SentryOfflineQueueBridge() {
  const isOnline = useNetworkStatus();

  useEffect(() => {
    if (isOnline) {
      noteConnectivityRestored();
    }
  }, [isOnline]);

  useEffect(() => {
    void processOfflineQueue();
  }, []);

  return null;
}

function OfflineSyncProvider({ children }: { children: React.ReactNode }) {
  const syncState = useOfflineSync();
  return (
    <OfflineSyncContext.Provider value={syncState}>
      {children}
    </OfflineSyncContext.Provider>
  );
}

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => createQueryClient());

  return (
    <QueryClientProvider client={queryClient}>
      <RequestQueueInstigator />
      <SharedStateQueryBridge />
      <SentryOfflineQueueBridge />
      <ThemeProvider>
        <WalletProvider>
          <SessionProvider>
            <OfflineSyncProvider>
              <AppErrorBoundary>
                {children}
                <WalletStatusBar />
              </AppErrorBoundary>
            </OfflineSyncProvider>
          </SessionProvider>
        </WalletProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
