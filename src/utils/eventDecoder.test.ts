/**
 * eventDecoder.test.ts
 * Unit tests for hex decoding with known event hashes from contract deployment artifacts.
 *
 * Run with: npx jest src/utils/eventDecoder.test.ts
 */

import { decodeEvent, decodeEventBatch, RawSorobanEvent } from "./eventDecoder";
import { resetPipeline, processEvent } from "../services/alertPipeline";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a minimal XDR ScVal array hex string.
 * Encodes: [count, SCV_SYMBOL(name), ...SCV_STRING(values)]
 *
 * This matches the encoding the Stellar SDK produces for Soroban event topics.
 */
function encodeSymbol(s: string): string {
  // SCV_SYMBOL discriminant = 16 (0x00000010)
  const buf = Buffer.from(s, "utf8");
  const padded = Math.ceil(buf.length / 4) * 4;
  const padBuf = Buffer.alloc(padded);
  buf.copy(padBuf);
  return (
    "00000010" +
    buf.length.toString(16).padStart(8, "0") +
    padBuf.toString("hex")
  );
}

function encodeString(s: string): string {
  // SCV_STRING discriminant = 15 (0x0000000f)
  const buf = Buffer.from(s, "utf8");
  const padded = Math.ceil(buf.length / 4) * 4;
  const padBuf = Buffer.alloc(padded);
  buf.copy(padBuf);
  return (
    "0000000f" +
    buf.length.toString(16).padStart(8, "0") +
    padBuf.toString("hex")
  );
}

function encodeU32(n: number): string {
  // SCV_U32 discriminant = 6 (0x00000006)
  return "00000006" + n.toString(16).padStart(8, "0");
}

function encodeI128(lo: bigint): string {
  // SCV_I128 discriminant = 11 (0x0000000b)
  // hi (8 bytes) + lo (8 bytes), big-endian
  const hiHex = "0000000000000000";
  const loBuf = Buffer.alloc(8);
  loBuf.writeBigUInt64BE(lo);
  return "0000000b" + hiHex + loBuf.toString("hex");
}

function buildTopicsHex(fields: string[]): string {
  const count = fields.length.toString(16).padStart(8, "0");
  return count + fields.join("");
}

function buildDataHex(fields: string[]): string {
  const count = fields.length.toString(16).padStart(8, "0");
  return count + fields.join("");
}

// ─── Known event fixtures ─────────────────────────────────────────────────────

const BANDWIDTH_CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
const ESCROW_CONTRACT    = "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBSC4";

const bandwidthAlertRaw: RawSorobanEvent = {
  contractId: BANDWIDTH_CONTRACT,
  topicsHex: buildTopicsHex([
    encodeSymbol("BandwidthAlert"),
    encodeString("node-42"),
  ]),
  dataHex: buildDataHex([
    encodeU32(90),  // usagePercent
    encodeU32(80),  // threshold
  ]),
  ledger: 1000,
  timestamp: 1_700_000_000_000,
};

const lowBalanceRaw: RawSorobanEvent = {
  contractId: ESCROW_CONTRACT,
  topicsHex: buildTopicsHex([
    encodeSymbol("LowBalance"),
    encodeString("GX:account1"),
  ]),
  dataHex: buildDataHex([
    encodeI128(500n),    // balance
    encodeString("XLM"), // currency
  ]),
  ledger: 1001,
  timestamp: 1_700_000_001_000,
};

const unknownContractRaw: RawSorobanEvent = {
  contractId: "CUNKNOWNUNKNOWNUNKNOWNUNKNOWNUNKNOWNUNKNOWNUNKNOWNUNKNOWN",
  topicsHex: buildTopicsHex([encodeSymbol("SomeEvent")]),
  dataHex:   buildDataHex([encodeU32(1)]),
  ledger: 1002,
  timestamp: 1_700_000_002_000,
};

const malformedRaw: RawSorobanEvent = {
  contractId: BANDWIDTH_CONTRACT,
  topicsHex: "ZZZZZZZZ",   // invalid hex
  dataHex:   "ZZZZZZZZ",
  ledger: 1003,
  timestamp: 1_700_000_003_000,
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("eventDecoder — decodeEvent", () => {
  test("decodes a BandwidthAlert event correctly", () => {
    const result = decodeEvent(bandwidthAlertRaw);

    expect(result).not.toBeNull();
    expect(result!.eventName).toBe("BandwidthAlert");
    expect(result!.contractName).toBe("NodeBandwidth");
    expect(result!.fields.usagePercent).toBe(90);
    expect(result!.fields.threshold).toBe(80);
    expect(result!.fields.nodeId).toBe("node-42");
    expect(result!.description).toContain("node-42");
    expect(result!.description).toContain("90");
    expect(result!.severity).toBe("warning");
  });

  test("decodes a LowBalance event correctly", () => {
    const result = decodeEvent(lowBalanceRaw);

    expect(result).not.toBeNull();
    expect(result!.eventName).toBe("LowBalance");
    expect(result!.contractName).toBe("EscrowVault");
    expect(result!.fields.currency).toBe("XLM");
    expect(result!.severity).toBe("warning");
  });

  test("returns an Unknown event (not null) for unregistered contracts", () => {
    const result = decodeEvent(unknownContractRaw);

    expect(result).not.toBeNull();
    expect(result!.eventName).toBe("Unknown event");
    expect(result!.contractName).toBe("Unknown Contract");
    // Raw hex must be preserved
    expect(result!.raw).toBe(unknownContractRaw.topicsHex);
  });

  test("returns an Unknown event for malformed hex (no silent drop)", () => {
    const result = decodeEvent(malformedRaw);

    expect(result).not.toBeNull();
    expect(result!.eventName).toBe("Unknown event");
  });

  test("produces a stable eventId fingerprint for the same input", () => {
    const a = decodeEvent(bandwidthAlertRaw);
    const b = decodeEvent(bandwidthAlertRaw);
    expect(a!.eventId).toBe(b!.eventId);
  });

  test("produces different eventIds for different inputs", () => {
    const a = decodeEvent(bandwidthAlertRaw);
    const b = decodeEvent(lowBalanceRaw);
    expect(a!.eventId).not.toBe(b!.eventId);
  });
});

describe("eventDecoder — decodeEventBatch", () => {
  test("decodes a batch of events without dropping any", () => {
    const batch: RawSorobanEvent[] = [
      bandwidthAlertRaw,
      lowBalanceRaw,
      unknownContractRaw,
    ];
    const results = decodeEventBatch(batch);
    // All three must come back (unknowns are kept, not dropped)
    expect(results).toHaveLength(3);
  });

  test("caps batch at 100 events without throwing", () => {
    const bigBatch = Array.from({ length: 150 }, (_, i) => ({
      ...bandwidthAlertRaw,
      dataHex: buildDataHex([encodeU32(i), encodeU32(80)]),
      timestamp: Date.now() + i,
    }));
    const results = decodeEventBatch(bigBatch);
    expect(results.length).toBeLessThanOrEqual(100);
  });
});

describe("eventDecoder — severity classification", () => {
  test("BandwidthAlert is classified as warning", () => {
    expect(decodeEvent(bandwidthAlertRaw)!.severity).toBe("warning");
  });

  test("Unknown events default to info severity", () => {
    expect(decodeEvent(unknownContractRaw)!.severity).toBe("info");
  });
});

describe("alertPipeline — deduplication", () => {
  beforeEach(() => resetPipeline());

  test("emits an alert only once within 10 seconds for same eventId", () => {
    const received: string[] = [];
    const decoded = decodeEvent(bandwidthAlertRaw)!;

    const { subscribeToAlerts } = require("../services/alertPipeline");
    const unsub = subscribeToAlerts((a: { id: string }) => received.push(a.id));

    processEvent(decoded);
    processEvent(decoded); // duplicate — same id, same timestamp
    processEvent(decoded);

    expect(received).toHaveLength(1);
    unsub();
  });

  test("emits again after the dedup window (simulated by mutating timestamp)", () => {
    const received: string[] = [];
    const decoded = decodeEvent(bandwidthAlertRaw)!;

    const { subscribeToAlerts } = require("../services/alertPipeline");
    const unsub = subscribeToAlerts((a: { id: string }) => received.push(a.id));

    processEvent(decoded);

    // Simulate event arriving >10 s later by patching timestamp
    const later = { ...decoded, timestamp: decoded.timestamp + 11_000 };
    processEvent(later);

    expect(received).toHaveLength(2);
    unsub();
  });
});