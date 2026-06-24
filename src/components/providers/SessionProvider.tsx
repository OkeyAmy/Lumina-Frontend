"use client";

import { createContext, useContext, type ReactNode } from "react";
import { SessionState } from "@/src/services/sessionWatcher";
import { useSessionWatcher } from "@/src/hooks/useSessionWatcher";

const SessionStateContext = createContext<SessionState>(SessionState.ACTIVE);

export function SessionProvider({ children }: { children: ReactNode }) {
  const { sessionState } = useSessionWatcher();
  return (
    <SessionStateContext.Provider value={sessionState}>
      {children}
    </SessionStateContext.Provider>
  );
}

export function useSessionState(): SessionState {
  return useContext(SessionStateContext);
}
