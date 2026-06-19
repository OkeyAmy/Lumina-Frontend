"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useProvisionToken } from "@/src/hooks/useProvisionToken";
import { renderQRCode } from "@/src/lib/qrGenerator";
import { sanitizeNodeString, detectDangerPatterns } from "@/src/utils/sanitizer";
import type {
  NodeConfig,
  ProvisionAttempt,
} from "@/src/types/provisioning";
import { PROVISION_TOKEN_TTL_MS } from "@/src/types/provisioning";

export interface QRProvisionPanelProps {
  nodeConfig: NodeConfig | null;
  /** Callback fired when a provisioning log entry is updated */
  onProvisioningLogChange?: (attempts: ProvisionAttempt[]) => void;
}

function formatTimeRemaining(ms: number): string {
  if (ms <= 0) return "Expired";
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

/**
 * NodeConfigSummary displays the sanitized node configuration details.
 * All values are passed through the XSS sanitizer before rendering.
 */
function NodeConfigSummary({ config }: { config: NodeConfig }) {
  const safeName = useMemo(() => sanitizeNodeString(config.name), [config.name]);
  const safeLocation = useMemo(() => sanitizeNodeString(config.location), [config.location]);
  const safeModel = useMemo(() => sanitizeNodeString(config.model), [config.model]);

  // Run danger-pattern detection as a side-effect (monitoring/analytics)
  useEffect(() => {
    detectDangerPatterns(config.name);
    detectDangerPatterns(config.location);
    detectDangerPatterns(config.model);
  }, [config.name, config.location, config.model]);

  return (
    <div className="border-t border-[#ece5d8] px-5 py-4" data-testid="qr-config-summary">
      <h3 className="mb-3 text-xs font-semibold uppercase tracking-[0.12em] text-[#6f5f48]">
        Node Configuration
      </h3>
      <dl className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div>
          <dt className="text-xs text-[#6f5f48]">Name</dt>
          <dd
            className="mt-0.5 text-sm font-medium text-[#171512]"
            data-testid="qr-config-name"
            dangerouslySetInnerHTML={{ __html: safeName }}
          />
        </div>
        <div>
          <dt className="text-xs text-[#6f5f48]">Location</dt>
          <dd
            className="mt-0.5 text-sm font-medium text-[#171512]"
            data-testid="qr-config-location"
            dangerouslySetInnerHTML={{ __html: safeLocation }}
          />
        </div>
        <div>
          <dt className="text-xs text-[#6f5f48]">Model</dt>
          <dd
            className="mt-0.5 text-sm font-medium text-[#171512]"
            data-testid="qr-config-model"
            dangerouslySetInnerHTML={{ __html: safeModel }}
          />
        </div>
      </dl>
    </div>
  );
}

/**
 * QRProvisionPanel renders a QR code for edge router onboarding.
 *
 * Features:
 * - Canvas-based QR code at high DPI for Retina displays
 * - Countdown timer showing remaining validity
 * - Auto-refreshes the QR when the token expires
 * - Manual Refresh button
 * - Mobile-responsive layout for field technicians using tablets
 * - Provisioning log showing recent attempts and their status
 */
export function QRProvisionPanel({
  nodeConfig,
  onProvisioningLogChange,
}: QRProvisionPanelProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { token, loading, error, remainingMs, refresh } =
    useProvisionToken(nodeConfig);
  const [logEntries, setLogEntries] = useState<ProvisionAttempt[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);

  // Track provisioning attempts in the log
  useEffect(() => {
    if (!token || !nodeConfig) return;

    const entry: ProvisionAttempt = {
      id: `prov-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      nodeConfig,
      createdAt: Date.now(),
      status: "pending",
      token: token.token,
    };

    setLogEntries((prev) => {
      const next = [entry, ...prev].slice(0, 20); // Keep last 20 entries
      return next;
    });
  }, [token, nodeConfig]);

  // Notify parent of log changes
  useEffect(() => {
    if (onProvisioningLogChange) {
      onProvisioningLogChange(logEntries);
    }
  }, [logEntries, onProvisioningLogChange]);

  // Expire old pending entries
  useEffect(() => {
    const interval = setInterval(() => {
      setLogEntries((prev) =>
        prev.map((entry) => {
          if (entry.status === "pending") {
            const elapsed = Date.now() - entry.createdAt;
            if (elapsed > PROVISION_TOKEN_TTL_MS) {
              return { ...entry, status: "expired" as const };
            }
          }
          return entry;
        }),
      );
    }, 1000);

    return () => clearInterval(interval);
  }, []);

  // Render QR code onto canvas when token changes
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !token) return;

    void renderQRCode({
      data: token.token,
      canvas,
      width: 280,
      errorCorrectionLevel: "M",
      color: "#171512",
      backgroundColor: "#ffffff",
    }).catch(() => {
      // QR rendering failed silently — canvas may not be available
    });
  }, [token]);

  const handleRefresh = useCallback(async () => {
    setIsRefreshing(true);
    try {
      await refresh();
    } finally {
      setIsRefreshing(false);
    }
  }, [refresh]);

  const isExpired = remainingMs <= 0;
  const urgencyClass =
    remainingMs < 60_000
      ? "text-rose-600"
      : remainingMs < 180_000
        ? "text-amber-600"
        : "text-[#0f766e]";

  if (!nodeConfig) {
    return (
      <section className="rounded-lg border border-[#d8d0c1] bg-white p-6">
        <div className="flex flex-col items-center gap-3 py-12 text-center">
          <svg
            className="h-12 w-12 text-[#cfc4b1]"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M12 9v3.75m9-.75a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 3.75h.008v.008H12v-.008Z"
            />
          </svg>
          <p className="text-sm font-medium text-[#6f5f48]">
            Configure node settings to generate a provisioning QR code.
          </p>
        </div>
      </section>
    );
  }

  if (!token && !loading && !error) {
    return (
      <section className="rounded-lg border border-[#d8d0c1] bg-white p-6">
        <div className="flex flex-col items-center gap-3 py-12 text-center">
          <svg
            className="h-12 w-12 text-[#cfc4b1]"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M12 9v3.75m9-.75a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 3.75h.008v.008H12v-.008Z"
            />
          </svg>
          <p className="text-sm font-medium text-[#6f5f48]">
            Connect your wallet to generate a provisioning QR code.
          </p>
        </div>
      </section>
    );
  }

  return (
    <section className="rounded-lg border border-[#d8d0c1] bg-white">
      {/* Header */}
      <div className="flex flex-col gap-3 border-b border-[#d8d0c1] p-5 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold text-[#171512]">
            Provisioning QR Code
          </h2>
          <p className="mt-0.5 text-sm text-[#6f5f48]">
            Scan with router camera to auto-configure node on-chain
          </p>
        </div>
        <button
          type="button"
          onClick={handleRefresh}
          disabled={loading || isRefreshing}
          className="inline-flex items-center gap-2 rounded-md border border-[#cfc4b1] px-3 py-1.5 text-sm font-medium text-[#3e3830] transition hover:border-[#0f766e] hover:text-[#0f766e] disabled:opacity-50"
        >
          {isRefreshing || loading ? (
            <svg
              className="h-4 w-4 animate-spin"
              viewBox="0 0 16 16"
              fill="none"
              aria-hidden="true"
            >
              <circle
                cx="8"
                cy="8"
                r="6"
                stroke="currentColor"
                strokeWidth="2"
                strokeDasharray="28"
                strokeDashoffset="8"
                opacity="0.4"
              />
            </svg>
          ) : null}
          Refresh
        </button>
      </div>

      {/* QR Code area */}
      <div className="flex flex-col items-center gap-4 p-6">
        {error ? (
          <div className="w-full rounded-md border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
            {error}
            <button
              type="button"
              onClick={handleRefresh}
              className="ml-3 font-semibold underline underline-offset-2"
            >
              Retry
            </button>
          </div>
        ) : null}

        {/* Canvas for QR code — always rendered for test targeting */}
        <canvas
          ref={canvasRef}
          data-testid="qr-canvas"
          className="rounded-lg border border-[#ece5d8] bg-white"
          style={{ width: 280, height: 280 }}
          aria-label="Provisioning QR code"
        />

        {/* Countdown timer */}
        <div
          className="flex flex-col items-center gap-1"
          data-testid="qr-timer"
        >
          <div className="flex items-center gap-2">
            <span
              className={`text-sm font-medium text-[#6f5f48]`}
            >
              {isExpired ? "Refreshing..." : "Valid for"}
            </span>
            <span
              data-testid="qr-timer-value"
              className={`text-2xl font-bold tabular-nums ${urgencyClass}`}
            >
              {formatTimeRemaining(remainingMs)}
            </span>
          </div>
          <div className="h-2 w-48 rounded-full bg-[#ece5d8]">
            <div
              className={`h-2 rounded-full transition-all duration-1000 ${
                isExpired ? "bg-rose-400" : "bg-[#0f766e]"
              }`}
              style={{
                width: `${Math.max(0, Math.min(100, (remainingMs / PROVISION_TOKEN_TTL_MS) * 100))}%`,
              }}
            />
          </div>
        </div>
      </div>

      {/* Node config summary */}
      {nodeConfig && (
        <NodeConfigSummary config={nodeConfig} />
      )}

      {/* Provisioning log */}
      <div className="border-t border-[#ece5d8] px-5 py-4">
        <h3 className="mb-3 text-xs font-semibold uppercase tracking-[0.12em] text-[#6f5f48]">
          Provisioning Log
        </h3>
        {logEntries.length === 0 ? (
          <p className="py-4 text-center text-sm text-[#6f5f48]">
            No provisioning attempts recorded yet.
          </p>
        ) : (
          <div className="max-h-48 space-y-2 overflow-y-auto">
            {logEntries.map((entry) => {
              const statusConfig: Record<
                ProvisionAttempt["status"],
                { label: string; className: string }
              > = {
                pending: {
                  label: "Pending",
                  className:
                    "bg-amber-50 text-amber-800 border-amber-200",
                },
                claimed: {
                  label: "Claimed",
                  className:
                    "bg-green-50 text-green-800 border-green-200",
                },
                expired: {
                  label: "Expired",
                  className:
                    "bg-yellow-50 text-yellow-800 border-yellow-200",
                },
              };
              const { label, className } = statusConfig[entry.status];

              return (
                <div
                  key={entry.id}
                  className="flex items-center justify-between gap-3 rounded-md border border-[#ece5d8] px-3 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span
                        className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[10px] font-semibold ${className}`}
                      >
                        {label}
                      </span>
                      <span className="truncate text-xs font-medium text-[#171512]">
                        {entry.nodeConfig.name}
                      </span>
                    </div>
                    <p className="mt-0.5 text-[10px] text-[#6f5f48]">
                      {new Date(entry.createdAt).toLocaleString(undefined, {
                        month: "short",
                        day: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                        second: "2-digit",
                      })}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
