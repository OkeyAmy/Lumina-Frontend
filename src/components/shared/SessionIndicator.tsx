"use client";

import { useSessionState } from "@/src/components/providers/SessionProvider";
import { SessionState } from "@/src/services/sessionWatcher";
import { useWalletIdentity } from "@/src/hooks/useWalletIdentity";

const STATE_CONFIG: Record<
  SessionState,
  { color: string; label: string; dot: string }
> = {
  [SessionState.ACTIVE]: {
    color: "bg-green-500",
    label: "Authenticated",
    dot: "bg-green-500",
  },
  [SessionState.IDLE_LOCKED]: {
    color: "bg-yellow-500",
    label: "Session idle",
    dot: "bg-yellow-500",
  },
  [SessionState.WALLET_DISCONNECTED]: {
    color: "bg-red-500",
    label: "Wallet disconnected",
    dot: "bg-red-500",
  },
  [SessionState.FORCE_LOGOUT]: {
    color: "bg-red-500",
    label: "Session expired",
    dot: "bg-red-500",
  },
};

export function SessionIndicator() {
  const { publicKey } = useWalletIdentity();
  const sessionState = useSessionState();
  const config = STATE_CONFIG[sessionState];

  if (!publicKey) return null;

  return (
    <div
      data-testid="session-indicator"
      className="flex items-center gap-1.5"
      title={config.label}
    >
      <span
        data-testid="session-dot"
        data-state={sessionState}
        className={`inline-block h-2 w-2 rounded-full ${config.dot} shadow-sm`}
        aria-hidden
      />
      <span className="hidden text-xs font-medium text-muted sm:inline">
        {config.label}
      </span>
    </div>
  );
}
