// Run with: npx tsx src/lib/__tests__/idbClient.test.ts
import "fake-indexeddb/auto";

import {
  saveInspectionRecord,
  saveNodeConfigSnapshot,
  getInspectionRecords,
  getNodeConfigSnapshots,
  getSyncQueue,
  getSyncQueueSize,
  flushSyncQueue,
  clearAllFieldData,
  getSyncMetadata,
} from "../idbClient";

interface FailedTest {
  name: string;
  reason: string;
}

const failures: FailedTest[] = [];

function assert<T>(name: string, expected: T, actual: T) {
  const ok =
    JSON.stringify(expected) === JSON.stringify(actual) ||
    expected === (actual as unknown);
  if (!ok) {
    failures.push({ name, reason: `expected ${JSON.stringify(expected)} but got ${JSON.stringify(actual)}` });
    console.error(`  ✗ ${name}`);
  } else {
    console.log(`  ✓ ${name}`);
  }
}

async function isolated(fn: () => Promise<void>) {
  await clearAllFieldData();
  try {
    await fn();
  } finally {
    await clearAllFieldData();
  }
}

const baseRecord = {
  nodeId: "node-1",
  technicianId: "tech-1",
  status: "pass",
  notes: "all good",
  checklist: { antennaCheck: true, powerCheck: true },
  createdAt: "2026-06-20T10:00:00.000Z",
  updatedAt: "2026-06-20T10:00:00.000Z",
};

const baseSnapshot = {
  nodeId: "node-2",
  config: { txPower: 20, channel: 6 },
  version: 1,
  snapshotAt: "2026-06-20T10:01:00.000Z",
};

async function run() {
  // ── Write-local-first ───────────────────────────────────────────────────
  console.log("idbClient: write-local-first — inspection record");
  await isolated(async () => {
    const id = await saveInspectionRecord(baseRecord);
    assert("returns a numeric id", true, typeof id === "number");

    const records = await getInspectionRecords();
    assert("record written to inspectionRecords", 1, records.length);
    assert("nodeId persisted", "node-1", records[0].nodeId);

    const queue = await getSyncQueue();
    assert("sync queue entry created", 1, queue.length);
    assert("queue entry targets inspectionRecords", "inspectionRecords", queue[0].collection);
    assert("retryCount starts at 0", 0, queue[0].retryCount);
    assert("lastAttemptAt starts null", null, queue[0].lastAttemptAt);
  });

  console.log("idbClient: write-local-first — node config snapshot");
  await isolated(async () => {
    await saveNodeConfigSnapshot(baseSnapshot);
    const snapshots = await getNodeConfigSnapshots();
    assert("snapshot written to nodeConfigSnapshots", 1, snapshots.length);
    const queue = await getSyncQueue();
    assert("sync queue entry targets nodeConfigSnapshots", "nodeConfigSnapshots", queue[0].collection);
  });

  // ── FIFO ordering ───────────────────────────────────────────────────────
  console.log("idbClient: sync queue is FIFO ordered by createdAt");
  await isolated(async () => {
    await saveInspectionRecord({ ...baseRecord, createdAt: "2026-06-20T10:00:00.000Z", updatedAt: "2026-06-20T10:00:00.000Z" });
    await saveInspectionRecord({ ...baseRecord, createdAt: "2026-06-20T10:05:00.000Z", updatedAt: "2026-06-20T10:05:00.000Z" });
    await saveInspectionRecord({ ...baseRecord, createdAt: "2026-06-20T09:55:00.000Z", updatedAt: "2026-06-20T09:55:00.000Z" });
    const queue = await getSyncQueue();
    assert("queue has 3 entries", 3, queue.length);
    assert("oldest entry is first", "2026-06-20T09:55:00.000Z", queue[0].createdAt);
    assert("newest entry is last", "2026-06-20T10:05:00.000Z", queue[2].createdAt);
  });

  // ── Flush: all succeed ──────────────────────────────────────────────────
  console.log("idbClient: flush removes all entries on success");
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("ok", { status: 200 })) as typeof fetch;
  await isolated(async () => {
    await saveInspectionRecord(baseRecord);
    await saveNodeConfigSnapshot(baseSnapshot);
    assert("queue has 2 before flush", 2, await getSyncQueueSize());

    const result = await flushSyncQueue();
    assert("attempted 2", 2, result.attempted);
    assert("succeeded 2", 2, result.succeeded);
    assert("failed 0", 0, result.failed);
    assert("queue empty after flush", 0, await getSyncQueueSize());

    const meta = await getSyncMetadata("inspectionRecords");
    assert("syncStatus set to idle", "idle", meta?.syncStatus);
  });
  globalThis.fetch = realFetch;

  // ── Flush: 5xx stops batch but preserves remaining entries ─────────────
  console.log("idbClient: flush stops on 5xx but remaining entries stay queued");
  let callCount = 0;
  globalThis.fetch = (async () => {
    callCount++;
    return callCount === 1
      ? new Response("ok", { status: 200 })
      : new Response("error", { status: 503 });
  }) as typeof fetch;
  await isolated(async () => {
    callCount = 0;
    // Insert in deterministic time order so the first is processed first
    await saveInspectionRecord({ ...baseRecord, createdAt: "2026-06-20T10:00:00.000Z", updatedAt: "2026-06-20T10:00:00.000Z" });
    await saveInspectionRecord({ ...baseRecord, createdAt: "2026-06-20T10:01:00.000Z", updatedAt: "2026-06-20T10:01:00.000Z" });
    await saveInspectionRecord({ ...baseRecord, createdAt: "2026-06-20T10:02:00.000Z", updatedAt: "2026-06-20T10:02:00.000Z" });

    const result = await flushSyncQueue();
    assert("attempted 3", 3, result.attempted);
    assert("succeeded 1", 1, result.succeeded);
    assert("failed 1", 1, result.failed);
    assert("2 entries still queued (resumable)", 2, await getSyncQueueSize());
  });
  globalThis.fetch = realFetch;

  // ── Flush: network down stops immediately ───────────────────────────────
  console.log("idbClient: flush stops immediately on network error");
  globalThis.fetch = (async () => { throw new Error("network down"); }) as typeof fetch;
  await isolated(async () => {
    await saveInspectionRecord(baseRecord);
    const result = await flushSyncQueue();
    assert("attempted 1", 1, result.attempted);
    assert("succeeded 0", 0, result.succeeded);
    assert("failed 1", 1, result.failed);
    assert("entry still queued after network error", 1, await getSyncQueueSize());

    const queue = await getSyncQueue();
    assert("retryCount incremented", 1, queue[0].retryCount);
    assert("lastAttemptAt set", true, queue[0].lastAttemptAt !== null);
  });
  globalThis.fetch = realFetch;

  // ── Conflict resolution: server timestamp wins ──────────────────────────
  console.log("idbClient: 409 — server is newer, local entry discarded");
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({ serverTimestamp: "2026-06-20T12:00:00.000Z" }),
      { status: 409, headers: { "Content-Type": "application/json" } }
    )
  ) as typeof fetch;
  await isolated(async () => {
    await saveInspectionRecord({ ...baseRecord, updatedAt: "2026-06-20T10:00:00.000Z" });
    const result = await flushSyncQueue();
    assert("server-wins: succeeded 1", 1, result.succeeded);
    assert("server-wins: queue empty", 0, await getSyncQueueSize());
    const meta = await getSyncMetadata("inspectionRecords");
    assert("server-wins: syncStatus idle", "idle", meta?.syncStatus);
  });
  globalThis.fetch = realFetch;

  console.log("idbClient: 409 — local is newer, entry kept for retry");
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({ serverTimestamp: "2026-06-20T08:00:00.000Z" }),
      { status: 409, headers: { "Content-Type": "application/json" } }
    )
  ) as typeof fetch;
  await isolated(async () => {
    await saveInspectionRecord({ ...baseRecord, updatedAt: "2026-06-20T10:00:00.000Z" });
    const result = await flushSyncQueue();
    assert("local-wins: failed 1", 1, result.failed);
    assert("local-wins: queue still has entry", 1, await getSyncQueueSize());
    const meta = await getSyncMetadata("inspectionRecords");
    assert("local-wins: syncStatus error", "error", meta?.syncStatus);
  });
  globalThis.fetch = realFetch;

  // ── nodeId index ────────────────────────────────────────────────────────
  console.log("idbClient: getNodeConfigSnapshots filters by nodeId");
  await isolated(async () => {
    await saveNodeConfigSnapshot({ ...baseSnapshot, nodeId: "node-A" });
    await saveNodeConfigSnapshot({ ...baseSnapshot, nodeId: "node-B" });
    await saveNodeConfigSnapshot({ ...baseSnapshot, nodeId: "node-A" });

    const aSnaps = await getNodeConfigSnapshots("node-A");
    assert("filters to node-A only", 2, aSnaps.length);
    const bSnaps = await getNodeConfigSnapshots("node-B");
    assert("filters to node-B only", 1, bSnaps.length);
  });

  if (failures.length > 0) {
    console.error(`\n${failures.length} test failure(s):`);
    for (const f of failures) console.error(` - ${f.name}: ${f.reason}`);
    process.exit(1);
  }
  console.log("\nAll idbClient assertions passed.");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

export {};
