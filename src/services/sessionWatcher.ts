"use client";

export enum SessionState {
  ACTIVE = "ACTIVE",
  IDLE_LOCKED = "IDLE_LOCKED",
  WALLET_DISCONNECTED = "WALLET_DISCONNECTED",
  FORCE_LOGOUT = "FORCE_LOGOUT",
}

export type SessionStateChangeHandler = (state: SessionState) => void;

const DEFAULT_POLL_INTERVAL_MS = 500;
const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60 * 1000;

export interface FreighterAPI {
  isConnected: () => Promise<{ isConnected: boolean }>;
  getUserInfo: () => Promise<{ publicKey?: string }>;
}

export interface SessionWatcherEnvironment {
  freighter: FreighterAPI | null;
  location: { href: string; assign: (url: string) => void };
  sessionStorage: Storage | null;
  fetch: typeof globalThis.fetch;
}

export interface SessionWatcherOptions {
  pollIntervalMs?: number;
  idleTimeoutMs?: number;
  onStateChange?: SessionStateChangeHandler;
  env?: SessionWatcherEnvironment;
  onLogout?: () => void;
}

function getDefaultEnvironment(): SessionWatcherEnvironment {
  const isBrowser = typeof window !== "undefined";
  return {
    freighter: isBrowser ? (window.freighter ?? null) : null,
    location: isBrowser
      ? window.location
      : { href: "", assign: () => {} },
    sessionStorage: isBrowser ? window.sessionStorage : null,
    fetch: isBrowser ? window.fetch.bind(window) : (async () => new Response()) as typeof fetch,
  };
}

const ACTIVITY_EVENTS = ["mousemove", "keydown", "touchstart", "click", "scroll"] as const;

export class SessionWatcher {
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private state: SessionState = SessionState.ACTIVE;
  private lastActivityTime = Date.now();
  private running = false;
  private currentPublicKey: string | null = null;
  private readonly boundHandleActivity: () => void;

  readonly pollIntervalMs: number;
  readonly idleTimeoutMs: number;
  readonly onStateChange: SessionStateChangeHandler;
  readonly env: SessionWatcherEnvironment;
  readonly onLogout: () => void;

  constructor(options: SessionWatcherOptions = {}) {
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.onStateChange = options.onStateChange ?? (() => {});
    this.env = options.env ?? getDefaultEnvironment();
    this.onLogout = options.onLogout ?? (() => {});
    this.boundHandleActivity = this.handleActivity.bind(this);
  }

  start(publicKey: string | null): void {
    if (this.running) return;
    this.running = true;
    this.currentPublicKey = publicKey;
    this.lastActivityTime = Date.now();
    this.state = SessionState.ACTIVE;
    this.onStateChange(SessionState.ACTIVE);

    if (publicKey) {
      this.startWalletPolling();
      this.startIdleDetection();
    }
  }

  updatePublicKey(publicKey: string | null): void {
    const wasConnected = !!this.currentPublicKey;
    this.currentPublicKey = publicKey;

    if (!this.running) return;

    if (publicKey) {
      this.state = SessionState.ACTIVE;
      this.lastActivityTime = Date.now();
      this.onStateChange(SessionState.ACTIVE);
      this.startWalletPolling();
      this.startIdleDetection();
    } else if (wasConnected) {
      this.stopWalletPolling();
      this.stopIdleDetection();
    }
  }

  stop(): void {
    this.running = false;
    this.stopWalletPolling();
    this.stopIdleDetection();
    this.currentPublicKey = null;
  }

  getState(): SessionState {
    return this.state;
  }

  private startWalletPolling(): void {
    this.stopWalletPolling();
    this.pollTimer = setInterval(() => {
      this.checkWalletConnection();
    }, this.pollIntervalMs);
  }

  private stopWalletPolling(): void {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private async checkWalletConnection(): Promise<void> {
    if (!this.env.freighter) return;

    try {
      const { isConnected } = await this.env.freighter.isConnected();
      if (!isConnected) {
        this.transitionTo(SessionState.WALLET_DISCONNECTED);
        return;
      }

      const info = await this.env.freighter.getUserInfo();
      const detectedKey = info.publicKey ?? null;

      if (detectedKey && detectedKey !== this.currentPublicKey) {
        return;
      }

      if (!detectedKey) {
        this.transitionTo(SessionState.WALLET_DISCONNECTED);
        return;
      }
    } catch {
      this.transitionTo(SessionState.WALLET_DISCONNECTED);
    }
  }

  private startIdleDetection(): void {
    this.stopIdleDetection();
    this.lastActivityTime = Date.now();

    if (typeof window !== "undefined") {
      for (const event of ACTIVITY_EVENTS) {
        window.addEventListener(event, this.boundHandleActivity, { passive: true });
      }
    }

    this.resetIdleTimer();
  }

  private stopIdleDetection(): void {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.tickTimer !== null) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }

    if (typeof window !== "undefined") {
      for (const event of ACTIVITY_EVENTS) {
        window.removeEventListener(event, this.boundHandleActivity);
      }
    }
  }

  private readonly handleActivity = (): void => {
    this.lastActivityTime = Date.now();
    if (this.state === SessionState.IDLE_LOCKED) {
      this.transitionTo(SessionState.ACTIVE);
    }
    this.resetIdleTimer();
  };

  private resetIdleTimer(): void {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
    }

    this.idleTimer = setTimeout(() => {
      this.transitionTo(SessionState.IDLE_LOCKED);
    }, this.idleTimeoutMs);
  }

  private transitionTo(newState: SessionState): void {
    if (this.state === newState || !this.running) return;
    this.state = newState;
    this.onStateChange(newState);

    if (
      newState === SessionState.WALLET_DISCONNECTED ||
      newState === SessionState.IDLE_LOCKED
    ) {
      this.executeLogout(newState === SessionState.IDLE_LOCKED ? "idle" : "wallet");
    }
  }

  private executeLogout(reason: "idle" | "wallet"): void {
    this.stopWalletPolling();
    this.stopIdleDetection();

    const token =
      this.env.sessionStorage?.getItem("lumina:auth:token") ?? null;

    if (this.env.sessionStorage) {
      try {
        this.env.sessionStorage.clear();
      } catch {
        // Best-effort
      }
    }

    this.onLogout();

    if (token) {
      this.env
        .fetch("/api/auth/revoke", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
        })
        .catch(() => {});
    }

    const params = new URLSearchParams();
    params.set("session", "expired");
    if (reason === "idle") {
      params.set("reason", "idle");
    }
    const separator = this.env.location.href.includes("?") ? "&" : "?";
    this.env.location.assign(
      `/login${separator}${params.toString()}`,
    );
  }
}
