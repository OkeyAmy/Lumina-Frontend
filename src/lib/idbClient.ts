"use client";

import { openDB, type DBSchema, type IDBPDatabase } from "idb";

export interface InspectionRecord {
  id?: number;
  nodeId: string;
  technicianId: string;
  status: string;
  notes: string;
  checklist: Record<string, boolean>;
  createdAt: string;
  updatedAt: string;
  serverTimestamp?: string;
}

export interface NodeConfigSnapshot {
  id?: number;
  nodeId: string;
  config: Record<string, unknown>;
  version: number;
  snapshotAt: string;
  serverTimestamp?: string;
}

export interface SyncQueueEntry {
  id?: number;
  collection: "inspectionRecords" | "nodeConfigSnapshots";
  payload: string;
  createdAt: string;
  retryCount: number;
  lastAttemptAt: string | null;
}

export interface SyncMetadata {
  id?: number;
  collection: string;
  lastSyncAt: string | null;
  syncStatus: "idle" | "syncing" | "error";
  errorMessage: string | null;
}

export interface SyncFlushResult {
  attempted: number;
  succeeded: number;
  failed: number;
}

interface LuminaFieldDB extends DBSchema {
  inspectionRecords: {
    key: number;
    value: InspectionRecord;
    indexes: { "by-nodeId": string; "by-createdAt": string };
  };
  nodeConfigSnapshots: {
    key: number;
    value: NodeConfigSnapshot;
    indexes: { "by-nodeId": string; "by-snapshotAt": string };
  };
  syncQueue: {
    key: number;
    value: SyncQueueEntry;
    indexes: { "by-collection": string; "by-createdAt": string };
  };
  syncMetadata: {
    key: number;
    value: SyncMetadata;
    indexes: { "by-collection": string };
  };
}

const DB_NAME = "lumina-field-db";
const DB_VERSION = 1;

let dbPromise: Promise<IDBPDatabase<LuminaFieldDB>> | null = null;

function hasIndexedDB(): boolean {
  return typeof indexedDB !== "undefined";
}

export function getFieldDb(): Promise<IDBPDatabase<LuminaFieldDB>> | null {
  if (!hasIndexedDB()) return null;
  if (!dbPromise) {
    dbPromise = openDB<LuminaFieldDB>(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion) {
        if (oldVersion < 1) {
          const ir = db.createObjectStore("inspectionRecords", {
            keyPath: "id",
            autoIncrement: true,
          });
          ir.createIndex("by-nodeId", "nodeId");
          ir.createIndex("by-createdAt", "createdAt");

          const nc = db.createObjectStore("nodeConfigSnapshots", {
            keyPath: "id",
            autoIncrement: true,
          });
          nc.createIndex("by-nodeId", "nodeId");
          nc.createIndex("by-snapshotAt", "snapshotAt");

          const sq = db.createObjectStore("syncQueue", {
            keyPath: "id",
            autoIncrement: true,
          });
          sq.createIndex("by-collection", "collection");
          sq.createIndex("by-createdAt", "createdAt");

          const sm = db.createObjectStore("syncMetadata", {
            keyPath: "id",
            autoIncrement: true,
          });
          sm.createIndex("by-collection", "collection");
        }
      },
      blocked() {},
    });
  }
  return dbPromise;
}

// ── Inspection Records ──────────────────────────────────────────────

export async function saveInspectionRecord(
  record: Omit<InspectionRecord, "id">
): Promise<number | null> {
  const db = await getFieldDb();
  if (!db) return null;
  const tx = db.transaction(["inspectionRecords", "syncQueue"], "readwrite");
  const id = await tx.objectStore("inspectionRecords").add(record as InspectionRecord);
  await tx.objectStore("syncQueue").add({
    collection: "inspectionRecords",
    payload: JSON.stringify({ ...record, id }),
    createdAt: record.createdAt,
    retryCount: 0,
    lastAttemptAt: null,
  } as SyncQueueEntry);
  await tx.done;
  return id;
}

export async function getInspectionRecords(): Promise<InspectionRecord[]> {
  const db = await getFieldDb();
  if (!db) return [];
  return db.getAllFromIndex("inspectionRecords", "by-createdAt");
}

// ── Node Config Snapshots ───────────────────────────────────────────

export async function saveNodeConfigSnapshot(
  snapshot: Omit<NodeConfigSnapshot, "id">
): Promise<number | null> {
  const db = await getFieldDb();
  if (!db) return null;
  const tx = db.transaction(["nodeConfigSnapshots", "syncQueue"], "readwrite");
  const id = await tx.objectStore("nodeConfigSnapshots").add(snapshot as NodeConfigSnapshot);
  await tx.objectStore("syncQueue").add({
    collection: "nodeConfigSnapshots",
    payload: JSON.stringify({ ...snapshot, id }),
    createdAt: snapshot.snapshotAt,
    retryCount: 0,
    lastAttemptAt: null,
  } as SyncQueueEntry);
  await tx.done;
  return id;
}

export async function getNodeConfigSnapshots(nodeId?: string): Promise<NodeConfigSnapshot[]> {
  const db = await getFieldDb();
  if (!db) return [];
  if (nodeId) {
    return db.getAllFromIndex("nodeConfigSnapshots", "by-nodeId", nodeId);
  }
  return db.getAllFromIndex("nodeConfigSnapshots", "by-snapshotAt");
}

// ── Sync Queue ──────────────────────────────────────────────────────

export async function getSyncQueue(): Promise<SyncQueueEntry[]> {
  const db = await getFieldDb();
  if (!db) return [];
  return db.getAllFromIndex("syncQueue", "by-createdAt");
}

export async function getSyncQueueSize(): Promise<number> {
  const db = await getFieldDb();
  if (!db) return 0;
  return db.count("syncQueue");
}

export async function removeSyncEntry(id: number): Promise<void> {
  const db = await getFieldDb();
  if (!db) return;
  await db.delete("syncQueue", id);
}

export async function updateSyncEntry(
  id: number,
  update: Partial<Pick<SyncQueueEntry, "retryCount" | "lastAttemptAt">>
): Promise<void> {
  const db = await getFieldDb();
  if (!db) return;
  const tx = db.transaction("syncQueue", "readwrite");
  const entry = await tx.store.get(id);
  if (entry) await tx.store.put({ ...entry, ...update });
  await tx.done;
}

export async function clearSyncQueue(): Promise<void> {
  const db = await getFieldDb();
  if (!db) return;
  await db.clear("syncQueue");
}

export async function clearAllFieldData(): Promise<void> {
  const db = await getFieldDb();
  if (!db) return;
  const tx = db.transaction(
    ["inspectionRecords", "nodeConfigSnapshots", "syncQueue", "syncMetadata"],
    "readwrite"
  );
  await tx.objectStore("inspectionRecords").clear();
  await tx.objectStore("nodeConfigSnapshots").clear();
  await tx.objectStore("syncQueue").clear();
  await tx.objectStore("syncMetadata").clear();
  await tx.done;
}

// ── Sync Metadata ───────────────────────────────────────────────────

export async function getSyncMetadata(
  collection: string
): Promise<SyncMetadata | undefined> {
  const db = await getFieldDb();
  if (!db) return undefined;
  const results = await db.getAllFromIndex("syncMetadata", "by-collection", collection);
  return results[0];
}

export async function upsertSyncMetadata(
  collection: string,
  update: Partial<Omit<SyncMetadata, "id" | "collection">>
): Promise<void> {
  const db = await getFieldDb();
  if (!db) return;
  const tx = db.transaction("syncMetadata", "readwrite");
  const existing = (await tx.store.index("by-collection").getAll(collection))[0];
  if (existing) {
    await tx.store.put({ ...existing, ...update });
  } else {
    await tx.store.add({
      collection,
      lastSyncAt: null,
      syncStatus: "idle",
      errorMessage: null,
      ...update,
    } as SyncMetadata);
  }
  await tx.done;
}

// ── Sync Flush ──────────────────────────────────────────────────────

const COLLECTION_ENDPOINTS: Record<SyncQueueEntry["collection"], string> = {
  inspectionRecords: "/api/inspections",
  nodeConfigSnapshots: "/api/node-configs",
};

/**
 * Drains the syncQueue FIFO, uploading each entry to its collection endpoint.
 *
 * - 5xx or network throw  → stops the batch immediately; entry retryCount++,
 *   remaining entries stay queued (resumable across reconnects).
 * - 409 Conflict          → last-writer-wins with server timestamp authority:
 *   server >= local → discard local and move on; server < local → keep entry
 *   for the next sync cycle.
 * - 4xx (non-409)         → permanent client-side rejection; remove and move on.
 */
export async function flushSyncQueue(): Promise<SyncFlushResult> {
  const entries = await getSyncQueue();
  const result: SyncFlushResult = { attempted: entries.length, succeeded: 0, failed: 0 };

  for (const entry of entries) {
    if (entry.id == null) continue;
    const base = process.env.NEXT_PUBLIC_API_BASE_URL ?? "";
    const url = base + COLLECTION_ENDPOINTS[entry.collection];
    const now = new Date().toISOString();

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: entry.payload,
        keepalive: true,
      });

      if (response.status === 409) {
        const serverData = (await response.json().catch(() => null)) as {
          serverTimestamp?: string;
        } | null;
        const local = JSON.parse(entry.payload) as {
          updatedAt?: string;
          snapshotAt?: string;
        };
        const localTs = new Date(local.updatedAt ?? local.snapshotAt ?? 0).getTime();
        const serverTs = serverData?.serverTimestamp
          ? new Date(serverData.serverTimestamp).getTime()
          : 0;

        if (serverTs >= localTs) {
          await removeSyncEntry(entry.id);
          await upsertSyncMetadata(entry.collection, {
            syncStatus: "idle",
            lastSyncAt: now,
            errorMessage: null,
          });
          result.succeeded++;
        } else {
          await updateSyncEntry(entry.id, {
            retryCount: entry.retryCount + 1,
            lastAttemptAt: now,
          });
          await upsertSyncMetadata(entry.collection, {
            syncStatus: "error",
            errorMessage: "Conflict: local record is newer, queued for retry",
          });
          result.failed++;
          return result;
        }
        continue;
      }

      if (!response.ok && response.status >= 500) {
        await updateSyncEntry(entry.id, {
          retryCount: entry.retryCount + 1,
          lastAttemptAt: now,
        });
        await upsertSyncMetadata(entry.collection, {
          syncStatus: "error",
          errorMessage: `Server error ${response.status}`,
        });
        result.failed++;
        return result;
      }

      await removeSyncEntry(entry.id);
      await upsertSyncMetadata(entry.collection, {
        syncStatus: "idle",
        lastSyncAt: now,
        errorMessage: null,
      });
      result.succeeded++;
    } catch {
      await updateSyncEntry(entry.id, {
        retryCount: entry.retryCount + 1,
        lastAttemptAt: now,
      });
      result.failed++;
      return result;
    }
  }

  return result;
}
