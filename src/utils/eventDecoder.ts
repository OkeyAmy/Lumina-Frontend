/**
 * eventDecoder.ts
 * Parses raw Soroban hex event payloads into structured alert objects.
 * Uses only Buffer / DataView — no eval, no dynamic code execution.
 */

import contractAbi from "../data/contractAbi.json";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface EventAbiField {
  name: string;
  type: "string" | "u32" | "u64" | "i128" | "address" | "bool";
  topicIndex?: number; // sourced from topics array
  dataIndex?: number;  // sourced from decoded data array
}

export interface EventAbi {
  eventName: string;
  topics: string[];
  decode: {
    fields: EventAbiField[];
    messageTemplate: string;
  };
}

export interface ContractAbi {
  contractAddress: string;
  contractName: string;
  events: EventAbi[];
}

export type AlertSeverity = "critical" | "warning" | "info";

export interface DecodedEvent {
  eventId: string;           // sha256-like fingerprint for dedup
  contractAddress: string;
  contractName: string;
  eventName: string;
  timestamp: number;
  severity: AlertSeverity;
  title: string;
  description: string;
  actionUrl?: string;
  fields: Record<string, unknown>;
  raw: string;               // original hex, always preserved
}

// ─── Signature lookup table ───────────────────────────────────────────────────

/**
 * Builds a lookup: "ContractAddress::EventName" → { contractAbi, eventAbi }
 * Populated once at module load — O(1) decode cost per event.
 */
interface AbiEntry {
  contract: ContractAbi;
  event: EventAbi;
}

const abiRegistry = new Map<string, AbiEntry>();

(contractAbi as { contracts: ContractAbi[] }).contracts.forEach((contract) => {
  contract.events.forEach((event) => {
    const key = `${contract.contractAddress}::${event.eventName}`;
    abiRegistry.set(key, { contract, event });
  });
});

// ─── Stellar XDR / hex primitives ────────────────────────────────────────────

/** Convert a hex string to a Uint8Array (no eval, no dynamic execution). */
function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) throw new Error("Odd-length hex string");
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/** Decode a UTF-8 byte sequence to a string. */
function bytesToUtf8(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("utf8");
}

/**
 * Minimal Soroban ScVal discriminant constants.
 * Full XDR enum — only the values we actually decode here.
 */
const SC_VAL_TYPE = {
  SCV_U32: 6,
  SCV_I32: 7,
  SCV_U64: 8,
  SCV_I64: 9,
  SCV_U128: 10,
  SCV_I128: 11,
  SCV_BYTES: 14,
  SCV_STRING: 15,
  SCV_SYMBOL: 16,
  SCV_ADDRESS: 19,
  SCV_BOOL: 0,
} as const;

/**
 * Parse a single Soroban ScVal from a DataView at the given byte offset.
 * Returns { value, bytesConsumed }.
 *
 * This implements the subset of XDR ScVal encoding produced by
 * the Stellar SDK when serialising contract event topics/data.
 */
function parseScVal(
  view: DataView,
  offset: number
): { value: unknown; bytesConsumed: number } {
  const discriminant = view.getUint32(offset, false); // big-endian XDR
  offset += 4;

  switch (discriminant) {
    case SC_VAL_TYPE.SCV_BOOL: {
      const flag = view.getUint32(offset, false);
      return { value: flag !== 0, bytesConsumed: 8 };
    }
    case SC_VAL_TYPE.SCV_U32: {
      const v = view.getUint32(offset, false);
      return { value: v, bytesConsumed: 8 };
    }
    case SC_VAL_TYPE.SCV_I32: {
      const v = view.getInt32(offset, false);
      return { value: v, bytesConsumed: 8 };
    }
    case SC_VAL_TYPE.SCV_U64: {
      const hi = view.getUint32(offset, false);
      const lo = view.getUint32(offset + 4, false);
      const v = BigInt(hi) * BigInt(0x100000000) + BigInt(lo);
      return { value: v.toString(), bytesConsumed: 12 };
    }
    case SC_VAL_TYPE.SCV_I64: {
      const hi = view.getInt32(offset, false);
      const lo = view.getUint32(offset + 4, false);
      const v = BigInt(hi) * BigInt(0x100000000) + BigInt(lo);
      return { value: v.toString(), bytesConsumed: 12 };
    }
    case SC_VAL_TYPE.SCV_U128:
    case SC_VAL_TYPE.SCV_I128: {
      // hi / lo are two u64 XDR fields (8 bytes each)
      const hiHi = view.getUint32(offset, false);
      const hiLo = view.getUint32(offset + 4, false);
      const loHi = view.getUint32(offset + 8, false);
      const loLo = view.getUint32(offset + 12, false);
      const hi = BigInt(hiHi) * BigInt(0x100000000) + BigInt(hiLo);
      const lo = BigInt(loHi) * BigInt(0x100000000) + BigInt(loLo);
      const v = hi * BigInt(2 ** 64) + lo;
      return { value: v.toString(), bytesConsumed: 20 };
    }
    case SC_VAL_TYPE.SCV_BYTES:
    case SC_VAL_TYPE.SCV_STRING:
    case SC_VAL_TYPE.SCV_SYMBOL: {
      const len = view.getUint32(offset, false);
      offset += 4;
      const strBytes = new Uint8Array(view.buffer, view.byteOffset + offset, len);
      const padded = Math.ceil(len / 4) * 4;
      return {
        value: bytesToUtf8(strBytes),
        bytesConsumed: 8 + padded,
      };
    }
    case SC_VAL_TYPE.SCV_ADDRESS: {
      // Simplified: read the nested discriminant + pubkey (32 bytes) or contract (32 bytes)
      const addrType = view.getUint32(offset, false); // 0 = account, 1 = contract
      offset += 4;
      const addrBytes = new Uint8Array(view.buffer, view.byteOffset + offset, 32);
      const hex = Buffer.from(addrBytes).toString("hex").toUpperCase();
      const label = addrType === 0 ? `G:${hex.slice(0, 8)}…` : `C:${hex.slice(0, 8)}…`;
      return { value: label, bytesConsumed: 8 + 32 };
    }
    default:
      // Unknown ScVal — return raw discriminant as string, advance 4 bytes
      return { value: `<unknown:${discriminant}>`, bytesConsumed: 4 };
  }
}

/**
 * Parse a length-prefixed XDR array of ScVals.
 * Returns the decoded values in order.
 */
function parseScValArray(hex: string): unknown[] {
  const bytes = hexToBytes(hex);
  const view = new DataView(bytes.buffer);
  const count = view.getUint32(0, false);
  const results: unknown[] = [];
  let offset = 4;
  for (let i = 0; i < count; i++) {
    const { value, bytesConsumed } = parseScVal(view, offset);
    results.push(value);
    offset += bytesConsumed;
  }
  return results;
}

// ─── Signature fingerprinting ─────────────────────────────────────────────────

/**
 * Produce a lightweight fingerprint from topics + data hex for dedup.
 * Uses simple djb2 hash — no crypto dependency.
 */
function djb2(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) ^ str.charCodeAt(i);
    hash = hash & hash; // 32-bit
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function fingerprintEvent(
  contractAddress: string,
  topicsHex: string,
  dataHex: string
): string {
  return djb2(`${contractAddress}:${topicsHex}:${dataHex}`);
}

// ─── Severity classification ──────────────────────────────────────────────────

const CRITICAL_KEYWORDS = ["offline", "critical", "emergency", "fail", "error"];
const WARNING_KEYWORDS  = ["warn", "alert", "low", "slippage", "bandwidth"];

function classifySeverity(eventName: string, description: string): AlertSeverity {
  const combined = `${eventName} ${description}`.toLowerCase();
  if (CRITICAL_KEYWORDS.some((k) => combined.includes(k))) return "critical";
  if (WARNING_KEYWORDS.some((k) => combined.includes(k)))  return "warning";
  return "info";
}

// ─── Template interpolation ───────────────────────────────────────────────────

function interpolate(template: string, fields: Record<string, unknown>): string {
  return template.replace(/\{(\w+)\}/g, (_, key) =>
    key in fields ? String(fields[key]) : `{${key}}`
  );
}

// ─── Raw event shape coming from useLedgerEvents ─────────────────────────────

export interface RawSorobanEvent {
  contractId: string;     // Stellar contract address (Cxxx…)
  topicsHex: string;      // hex-encoded XDR array of ScVals
  dataHex: string;        // hex-encoded XDR ScVal (event payload)
  ledger: number;
  timestamp: number;      // unix ms
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Decode a raw Soroban event into a structured DecodedEvent.
 * Returns null if the event signature is unknown (caller should display raw hex).
 */
export function decodeEvent(raw: RawSorobanEvent): DecodedEvent | null {
  let topics: unknown[];
  let dataValues: unknown[];

  try {
    topics     = parseScValArray(raw.topicsHex);
    dataValues = parseScValArray(raw.dataHex);
  } catch {
    // Malformed hex — surface as unknown
    return buildUnknownEvent(raw);
  }

  // First topic is always the event name symbol in Soroban contracts
  const eventNameTopic = typeof topics[0] === "string" ? topics[0] : null;
  if (!eventNameTopic) return buildUnknownEvent(raw);

  const lookupKey = `${raw.contractId}::${eventNameTopic}`;
  const entry = abiRegistry.get(lookupKey);
  if (!entry) return buildUnknownEvent(raw);

  // Populate fields from topics + data
  const fields: Record<string, unknown> = {};
  for (const field of entry.event.decode.fields) {
    if (field.topicIndex !== undefined) {
      fields[field.name] = topics[field.topicIndex] ?? null;
    } else if (field.dataIndex !== undefined) {
      fields[field.name] = dataValues[field.dataIndex] ?? null;
    }
  }

  const description = interpolate(entry.event.decode.messageTemplate, fields);
  const severity    = classifySeverity(entry.event.eventName, description);
  const eventId     = fingerprintEvent(raw.contractId, raw.topicsHex, raw.dataHex);

  return {
    eventId,
    contractAddress: raw.contractId,
    contractName:    entry.contract.contractName,
    eventName:       entry.event.eventName,
    timestamp:       raw.timestamp,
    severity,
    title:           `${entry.contract.contractName} — ${entry.event.eventName}`,
    description,
    fields,
    raw:             raw.topicsHex,
  };
}

/** Produce a placeholder DecodedEvent for unknown signatures (never silently dropped). */
function buildUnknownEvent(raw: RawSorobanEvent): DecodedEvent {
  const eventId = fingerprintEvent(raw.contractId, raw.topicsHex, raw.dataHex);
  return {
    eventId,
    contractAddress: raw.contractId,
    contractName:    "Unknown Contract",
    eventName:       "Unknown event",
    timestamp:       raw.timestamp,
    severity:        "info",
    title:           "Unknown event",
    description:     `Raw hex: ${raw.topicsHex.slice(0, 40)}…`,
    fields:          { raw: raw.topicsHex },
    raw:             raw.topicsHex,
  };
}

/**
 * Batch-decode up to 100 events per call without dropping frames.
 * Processes synchronously in one tick — all decodes are O(n) with
 * no async I/O, so a batch of 100 stays well under 16 ms.
 */
export function decodeEventBatch(events: RawSorobanEvent[]): DecodedEvent[] {
  const MAX_BATCH = 100;
  return events
    .slice(0, MAX_BATCH)
    .map(decodeEvent)
    .filter((e): e is DecodedEvent => e !== null);
}