/**
 * useLedgerEvents.ts
 * Subscribes to Soroban ledger events, decodes each raw hex payload
 * via eventDecoder, and pushes structured alerts into the alert pipeline
 * and Zustand store.
 *
 * Replaces the previous stub that surfaced raw hex to the UI.
 */

"use client";

import { useEffect, useRef } from "react";
import { decodeEvent, RawSorobanEvent } from "../utils/eventDecoder";
import { processEvent, subscribeToAlerts } from "../services/alertPipeline";
import { useAlertStore } from "./useAlertStore";

// ─── Simulated ledger event source ───────────────────────────────────────────
// In production replace this with your actual Stellar/Soroban RPC subscription
// (e.g. StellarSdk.Server.getEvents polling or a horizon SSE stream).

/**
 * Minimal interface for whatever event source you plug in.
 * Implement this for your real RPC client.
 */
interface LedgerEventSource {
  onEvent: (handler: (raw: RawSorobanEvent) => void) => void;
  start: () => void;
  stop: () => void;
}

// ─── XDR encoding helpers ─────────────────────────────────────────────────
// These mirror the exact encoding eventDecoder.ts expects (and that the
// real Stellar SDK produces). Hand-writing hex strings is error-prone —
// a single off-by-one in a length prefix corrupts every subsequent offset
// read, which is exactly what caused all mock events to decode as "Unknown".

function encodeSymbol(s: string): string {
  const buf = Buffer.from(s, "utf8");
  const padded = Math.ceil(buf.length / 4) * 4;
  const padBuf = Buffer.alloc(padded);
  buf.copy(padBuf);
  return "00000010" + buf.length.toString(16).padStart(8, "0") + padBuf.toString("hex");
}

function encodeString(s: string): string {
  const buf = Buffer.from(s, "utf8");
  const padded = Math.ceil(buf.length / 4) * 4;
  const padBuf = Buffer.alloc(padded);
  buf.copy(padBuf);
  return "0000000f" + buf.length.toString(16).padStart(8, "0") + padBuf.toString("hex");
}

function encodeU32(n: number): string {
  return "00000006" + n.toString(16).padStart(8, "0");
}

function encodeI128(lo: bigint): string {
  // Use DataView instead of Buffer.writeBigUInt64BE — the browser's Buffer
  // polyfill (used here because this hook runs client-side) doesn't implement
  // the bigint write methods that Node's native Buffer has.
  const bytes = new Uint8Array(8);
  const view = new DataView(bytes.buffer);
  view.setBigUint64(0, lo, false); // big-endian, matches XDR encoding
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return "0000000b" + "0000000000000000" + hex;
}

function topicsOf(...fields: string[]): string {
  return fields.length.toString(16).padStart(8, "0") + fields.join("");
}

function dataOf(...fields: string[]): string {
  return fields.length.toString(16).padStart(8, "0") + fields.join("");
}

/**
 * Mock source that replays a handful of realistic-looking hex events.
 * Replace with a real StellarSdk or horizon SSE subscription.
 */
function createMockEventSource(): LedgerEventSource {
  let handler: ((raw: RawSorobanEvent) => void) | null = null;
  let intervalId: ReturnType<typeof setInterval> | null = null;

  const mockEvents: RawSorobanEvent[] = [
    {
      contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4",
      topicsHex: topicsOf(encodeSymbol("BandwidthAlert"), encodeString("node-42")),
      dataHex: dataOf(encodeU32(90), encodeU32(80)),
      ledger: 1000,
      timestamp: Date.now(),
    },
    {
      contractId: "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBSC4",
      topicsHex: topicsOf(encodeSymbol("LowBalance"), encodeString("GX:account1")),
      dataHex: dataOf(encodeI128(500n), encodeString("XLM")),
      ledger: 1001,
      timestamp: Date.now() + 2000,
    },
  ];

  let idx = 0;

  return {
    onEvent(h) {
      handler = h;
    },
    start() {
      intervalId = setInterval(() => {
        if (!handler) return;
        const base = mockEvents[idx % mockEvents.length];

        // Vary the *data* payload (not topics — topics must stay structurally
        // intact for the event-name lookup to succeed) so consecutive emissions
        // get distinct eventId fingerprints and demonstrate the dedup window
        // rather than all collapsing into a single alert.
        const variedDataHex =
          base.contractId.startsWith("CAAA")
            ? dataOf(encodeU32(85 + (idx % 10)), encodeU32(80)) // BandwidthAlert usage%
            : dataOf(encodeI128(BigInt(400 + idx * 10)), encodeString("XLM")); // LowBalance amount

        handler({
          ...base,
          dataHex: variedDataHex,
          timestamp: Date.now(),
        });
        idx++;
      }, 3000);
    },
    stop() {
      if (intervalId) clearInterval(intervalId);
    },
  };
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

/**
 * useLedgerEvents
 *
 * Mount this once (e.g. in your root layout or a provider).
 * It wires the ledger event source → eventDecoder → alertPipeline → store.
 */
export function useLedgerEvents(): void {
  const addAlert   = useAlertStore((s) => s.addAlert);
  const sourceRef  = useRef<LedgerEventSource | null>(null);

  useEffect(() => {
    // 1. Subscribe to the alert pipeline so decoded alerts reach the store
    const unsub = subscribeToAlerts((alert) => {
      addAlert(alert);
    });

    // 2. Create and wire the event source
    const source = createMockEventSource();
    sourceRef.current = source;

    source.onEvent((raw: RawSorobanEvent) => {
      // 3. Decode hex → structured event
      const decoded = decodeEvent(raw);
      if (!decoded) return; // decodeEvent returns null only on hard parse failure

      // 4. Push through dedup + fan-out pipeline
      processEvent(decoded);
    });

    source.start();

    return () => {
      source.stop();
      unsub();
    };
  }, [addAlert]);
}



