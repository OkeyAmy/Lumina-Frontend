"use client";

/**
 * AlertFeed.tsx
 * Renders live decoded Soroban alerts grouped by severity.
 * Mounts useLedgerEvents to wire the full decode → pipeline → store loop.
 */

import React, { useState } from "react";
import { useLedgerEvents } from "../../hooks/useLedgerEvents";
import { useAlertStore } from "../../hooks/useAlertStore";
import { Alert, AlertSeverity } from "../../services/alertPipeline";

// ─── Severity config ──────────────────────────────────────────────────────────

const SEVERITY_META: Record<
  AlertSeverity,
  { label: string; border: string; bg: string; badge: string; dot: string }
> = {
  critical: {
    label: "Critical",
    border: "border-red-500",
    bg: "bg-red-950/40",
    badge: "bg-red-500 text-white",
    dot: "bg-red-500",
  },
  warning: {
    label: "Warning",
    border: "border-yellow-400",
    bg: "bg-yellow-950/40",
    badge: "bg-yellow-400 text-black",
    dot: "bg-yellow-400",
  },
  info: {
    label: "Info",
    border: "border-blue-400",
    bg: "bg-blue-950/30",
    badge: "bg-blue-400 text-white",
    dot: "bg-blue-400",
  },
};

const SEVERITY_ORDER: AlertSeverity[] = ["critical", "warning", "info"];

// ─── Sub-components ───────────────────────────────────────────────────────────

function AlertCard({ alert, onDismiss }: { alert: Alert; onDismiss: () => void }) {
  const meta = SEVERITY_META[alert.severity];
  const time = new Date(alert.timestamp).toLocaleTimeString();

  return (
    <div
      className={`
        relative rounded-lg border-l-4 p-4 mb-3
        ${meta.border} ${meta.bg}
        transition-opacity duration-300
        ${alert.dismissed ? "opacity-30 pointer-events-none" : "opacity-100"}
      `}
    >
      {/* Header row */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className={`inline-flex h-2 w-2 flex-shrink-0 rounded-full ${meta.dot}`} />
          <span className="font-semibold text-white text-sm truncate">
            {alert.title}
          </span>
          <span
            className={`
              hidden sm:inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium
              ${meta.badge}
            `}
          >
            {meta.label}
          </span>
        </div>

        <button
          onClick={onDismiss}
          aria-label="Dismiss alert"
          className="flex-shrink-0 text-gray-400 hover:text-white transition-colors text-lg leading-none"
        >
          ×
        </button>
      </div>

      {/* Description */}
      <p className="mt-1.5 text-gray-300 text-sm leading-snug">
        {alert.description}
      </p>

      {/* Footer */}
      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="text-xs text-gray-500 font-mono">{alert.contractName}</span>
        <span className="text-xs text-gray-500">{time}</span>
      </div>

      {/* Raw hex (collapsed by default) */}
      {alert.eventName === "Unknown event" && (
        <details className="mt-2">
          <summary className="text-xs text-gray-500 cursor-pointer select-none">
            Raw hex
          </summary>
          <pre className="mt-1 text-xs text-gray-400 font-mono break-all whitespace-pre-wrap">
            {alert.raw}
          </pre>
        </details>
      )}
    </div>
  );
}

function SeveritySection({
  severity,
  alerts,
  onDismiss,
}: {
  severity: AlertSeverity;
  alerts: Alert[];
  onDismiss: (id: string) => void;
}) {
  const meta = SEVERITY_META[severity];
  const visible = alerts.filter((a) => !a.dismissed);
  if (visible.length === 0) return null;

  return (
    <section className="mb-6">
      <div className="flex items-center gap-2 mb-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-400">
          {meta.label}
        </h2>
        <span
          className={`
            inline-flex items-center justify-center rounded-full px-2 py-0.5
            text-xs font-bold ${meta.badge}
          `}
        >
          {visible.length}
        </span>
      </div>

      {visible.map((alert) => (
        <AlertCard
          key={alert.id}
          alert={alert}
          onDismiss={() => onDismiss(alert.id)}
        />
      ))}
    </section>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export function AlertFeed() {
  // Wire the full decode pipeline
  useLedgerEvents();

  const { alerts, dismissAlert, clearAll } = useAlertStore();
  const [filter, setFilter] = useState<AlertSeverity | "all">("all");

  const activeAlerts = alerts.filter((a) => !a.dismissed);
  const filteredAlerts =
    filter === "all" ? alerts : alerts.filter((a) => a.severity === filter);

  return (
    <div className="w-full">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
        <div className="flex items-center gap-2">
          <span className="text-white font-semibold">Live Alerts</span>
          {activeAlerts.length > 0 && (
            <span className="inline-flex items-center justify-center rounded-full bg-gray-700 px-2 py-0.5 text-xs text-gray-200 font-medium">
              {activeAlerts.length}
            </span>
          )}
        </div>

        {/* Severity filter pills */}
        <div className="flex items-center gap-1.5 flex-wrap">
          {(["all", ...SEVERITY_ORDER] as const).map((s) => (
            <button
              key={s}
              onClick={() => setFilter(s)}
              className={`
                rounded-full px-3 py-1 text-xs font-medium transition-colors
                ${
                  filter === s
                    ? "bg-white text-gray-900"
                    : "bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-white"
                }
              `}
            >
              {s === "all" ? "All" : SEVERITY_META[s].label}
            </button>
          ))}

          {activeAlerts.length > 0 && (
            <button
              onClick={clearAll}
              className="ml-2 rounded-full px-3 py-1 text-xs font-medium bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-red-400 transition-colors"
            >
              Clear all
            </button>
          )}
        </div>
      </div>

      {/* Alert sections */}
      {activeAlerts.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-gray-600">
          <svg
            className="mb-3 h-10 w-10"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"
            />
          </svg>
          <p className="text-sm">No active alerts</p>
          <p className="text-xs mt-1">Listening for Soroban events…</p>
        </div>
      ) : (
        SEVERITY_ORDER.map((severity) => (
          <SeveritySection
            key={severity}
            severity={severity}
            alerts={filteredAlerts.filter((a) => a.severity === severity)}
            onDismiss={dismissAlert}
          />
        ))
      )}
    </div>
  );
}