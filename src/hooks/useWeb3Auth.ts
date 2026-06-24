"use client";

import { useCallback, useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useWalletIdentity } from "@/src/hooks/useWalletIdentity";
import {
  getStoredToken,
  setStoredToken,
  revokeAuthToken,
} from "@/src/lib/apiClient";
import { getSharedStateSync } from "@/src/services/sharedStateSync";

export interface Web3AuthState {
  isAuthenticated: boolean;
  token: string | null;
  login: () => Promise<void>;
  logout: () => Promise<void>;
  revoke: () => Promise<void>;
}

export function useWeb3Auth(): Web3AuthState {
  const { publicKey } = useWalletIdentity();
  const queryClient = useQueryClient();
  const [token, setToken] = useState<string | null>(null);

  useEffect(() => {
    setToken(getStoredToken());
  }, []);

  const login = useCallback(async () => {
    if (!publicKey) return;

    const challengeRes = await fetch("/api/auth/challenge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ publicKey }),
    });
    if (!challengeRes.ok) throw new Error("Failed to get auth challenge");

    const { challenge } = await challengeRes.json();

    if (!window.freighter?.signAuthEntry) {
      throw new Error("Freighter not available for signing");
    }
    const { signedAuthEntry } = await window.freighter.signAuthEntry(challenge);

    const tokenRes = await fetch("/api/auth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ publicKey, signedAuthEntry }),
    });
    if (!tokenRes.ok) throw new Error("Failed to exchange token");

    const { token: jwt } = await tokenRes.json();
    setStoredToken(jwt);
    setToken(jwt);
  }, [publicKey]);

  const logout = useCallback(async () => {
    setStoredToken(null);
    setToken(null);
    queryClient.clear();
    getSharedStateSync().publish("auth_expire", { reason: "logout" });
  }, [queryClient]);

  const revoke = useCallback(async () => {
    await revokeAuthToken();
    setToken(null);
    queryClient.clear();
  }, [queryClient]);

  return {
    isAuthenticated: !!token && !!publicKey,
    token,
    login,
    logout,
    revoke,
  };
}
