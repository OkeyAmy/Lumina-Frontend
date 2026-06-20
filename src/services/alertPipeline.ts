/**
 * alertPipeline.ts
 * Receives decoded Soroban events, deduplicates within a 10-second window,
 * and emits structured alerts to any registered alert store.
 */

import { DecodedEvent, AlertSeverity } from "../utils/eventDecoder";
export type { AlertSeverity };

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Alert {
  id: string;
  contractAddress: string;
  contractName: string;
  eventName: string;
  timestamp: number;
  severity: AlertSeverity;
  title: string;
  description: string;
  actionUrl?: string;
  dismissed: boolean;
  fields: Record<string, unknown>;
  raw: string;
}

export type AlertListener = (alert: Alert) => void;

// ─── Deduplication window ─────────────────────────────────────────────────────

const DEDUP_WINDOW_MS = 10_000; // 10 seconds

/**
 * Tracks the last-seen timestamp for each eventId.
 * Entries are pruned on each new event so memory doesn't grow unbounded.
 */
const seenEvents = new Map<string, number>();

function isDuplicate(eventId: string, timestamp: number): boolean {
  const lastSeen = seenEvents.get(eventId);
  if (lastSeen !== undefined && timestamp - lastSeen < DEDUP_WINDOW_MS) {
    return true;
  }
  seenEvents.set(eventId, timestamp);
  pruneSeenEvents(timestamp);
  return false;
}

/** Remove entries older than the dedup window to keep memory bounded. */
function pruneSeenEvents(now: number): void {
  for (const [id, ts] of seenEvents) {
    if (now - ts > DEDUP_WINDOW_MS) {
      seenEvents.delete(id);
    }
  }
}

// ─── Pipeline ─────────────────────────────────────────────────────────────────

const listeners: Set<AlertListener> = new Set();

/**
 * Register a callback that fires whenever a new, non-duplicate alert is emitted.
 * Returns an unsubscribe function.
 */
export function subscribeToAlerts(listener: AlertListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Convert a DecodedEvent to an Alert and fan-out to all listeners. */
function emitAlert(event: DecodedEvent): void {
  const alert: Alert = {
    id:              event.eventId,
    contractAddress: event.contractAddress,
    contractName:    event.contractName,
    eventName:       event.eventName,
    timestamp:       event.timestamp,
    severity:        event.severity,
    title:           event.title,
    description:     event.description,
    actionUrl:       event.actionUrl,
    dismissed:       false,
    fields:          event.fields,
    raw:             event.raw,
  };

  listeners.forEach((fn) => {
    try {
      fn(alert);
    } catch (err) {
      console.error("[alertPipeline] listener error:", err);
    }
  });
}

/**
 * Feed a single decoded event into the pipeline.
 * Silently drops duplicates within the 10-second window.
 */
export function processEvent(event: DecodedEvent): void {
  if (isDuplicate(event.eventId, event.timestamp)) return;
  emitAlert(event);
}

/**
 * Feed a batch of decoded events into the pipeline.
 * Each is individually dedup-checked.
 */
export function processBatch(events: DecodedEvent[]): void {
  events.forEach(processEvent);
}

/** Reset dedup state — useful in tests or on session restart. */
export function resetPipeline(): void {
  seenEvents.clear();
}
