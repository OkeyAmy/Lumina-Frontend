"use client";

import {
  createContext,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { setWalletTransitioningRef } from "@/src/lib/queryClient";

export interface WalletContextValue {
  publicKey: string | null;
  generation: number;
  isTransitioning: boolean;
  connect: () => Promise<void>;
  disconnect: () => void;
}

export const WalletContext = createContext<WalletContextValue | null>(null);

const FREIGHTER_ACCOUNT_CHANGE = "accountChange";

interface FreighterUserInfo {
  publicKey?: string;
}

declare global {
  interface Window {
    freighter?: {
      getUserInfo: () => Promise<FreighterUserInfo>;
      isConnected: () => Promise<{ isConnected: boolean }>;
      signTransaction?: (xdr: string) => Promise<{ signedTxXdr: string }>;
      signAuthEntry?: (authEntry: string) => Promise<{ signedAuthEntry: string }>;
    };
  }
}

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [isTransitioning, setIsTransitioning] = useState(false);
  const [generation, setGeneration] = useState(0);
  const queryClient = useQueryClient();

  const transitioningRef = useRef(false);
  const prevPublicKeyRef = useRef<string | null>(null);

  useEffect(() => {
    setWalletTransitioningRef(transitioningRef);
  }, []);

  const handleAccountChange = useCallback(async () => {
    transitioningRef.current = true;
    setIsTransitioning(true);

    await queryClient.cancelQueries();

    try {
      if (window.freighter) {
        const info = await window.freighter.getUserInfo();
        const newKey = info.publicKey ?? null;

        // Bump generation when the key changes, but keep the update
        // outside setPublicKey's functional updater — calling a state
        // setter inside another state updater is impure and will be
        // silently discarded by React 18+.
        if (prevPublicKeyRef.current !== newKey) {
          setGeneration((g) => g + 1);
        }
        setPublicKey(newKey);
        prevPublicKeyRef.current = newKey;
      }
    } catch {
      setPublicKey(null);
      prevPublicKeyRef.current = null;
    } finally {
      transitioningRef.current = false;
      setIsTransitioning(false);
    }
  }, [queryClient]);

  useEffect(() => {
    const handler = () => {
      handleAccountChange();
    };

    window.addEventListener(FREIGHTER_ACCOUNT_CHANGE, handler);
    return () => {
      window.removeEventListener(FREIGHTER_ACCOUNT_CHANGE, handler);
    };
  }, [handleAccountChange]);

  const connect = useCallback(async () => {
    try {
      if (window.freighter) {
        const { isConnected } = await window.freighter.isConnected();
        if (!isConnected) return;
      }
      await handleAccountChange();
    } catch {
      setPublicKey(null);
    }
  }, [handleAccountChange]);

  const disconnect = useCallback(() => {
    transitioningRef.current = true;
    setIsTransitioning(true);

    queryClient.cancelQueries();
    queryClient.clear();

    setPublicKey(null);
    setGeneration((g) => g + 1);
    prevPublicKeyRef.current = null;

    transitioningRef.current = false;
    setIsTransitioning(false);
  }, [queryClient]);

  const value = useMemo<WalletContextValue>(
    () => ({
      publicKey,
      generation,
      isTransitioning,
      connect,
      disconnect,
    }),
    [publicKey, generation, isTransitioning, connect, disconnect],
  );

  return (
    <WalletContext value={value}>
      {children}
    </WalletContext>
  );
}
