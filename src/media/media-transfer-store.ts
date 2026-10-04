import { MediaEngineError } from "./media-errors";
import { generateTransferId } from "./media-ids";
import { MEDIA_TRANSFER_TTL_MS } from "./media-limits";

export interface MediaTransferStore {
  stage(file: File): Promise<string>;
  take(transferId: string): Promise<File>;
  delete(transferId: string): Promise<void>;
  clearExpired(): Promise<number>;
}

interface TransferEntry {
  transferId: string;
  file: File;
  createdAt: number;
}

interface SerializedTransferEntry {
  transferId: string;
  name: string;
  type: string;
  lastModified: number;
  base64: string;
  createdAt: number;
}

const DATABASE_NAME = "capcam-media-transfer-v1";
const DATABASE_VERSION = 1;
const STORE_NAME = "pending-files";
const STORAGE_PREFIX = "capcam_xfer_";

const memoryFallback = new Map<string, TransferEntry>();

export function isExpiredMediaTransfer(createdAt: number, now = Date.now()): boolean {
  return !Number.isFinite(createdAt) || createdAt < now - MEDIA_TRANSFER_TTL_MS;
}

function isTransferEntry(value: unknown): value is TransferEntry {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.transferId === "string" &&
    typeof record.createdAt === "number" && Number.isFinite(record.createdAt) &&
    typeof record.file === "object" && record.file !== null &&
    typeof (record.file as File).name === "string" &&
    typeof (record.file as File).size === "number" &&
    typeof (record.file as File).slice === "function";
}

async function fileToBase64(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  if (typeof Buffer !== "undefined") {
    return Buffer.from(buffer).toString("base64");
  }
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const len = bytes.byteLength;
  const chunkSize = 0x8000;
  for (let i = 0; i < len; i += chunkSize) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunkSize)));
  }
  return btoa(binary);
}

function base64ToFile(base64: string, name: string, type: string, lastModified: number): File {
  let uint8: Uint8Array;
  if (typeof Buffer !== "undefined") {
    const buf = Buffer.from(base64, "base64");
    const arrayBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    uint8 = new Uint8Array(arrayBuffer);
  } else {
    const binary = atob(base64);
    const len = binary.length;
    uint8 = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      uint8[i] = binary.charCodeAt(i);
    }
  }
  return new File([uint8 as unknown as BlobPart], name, { type, lastModified });
}

/**
 * Short-lived local File handoff between popup and offscreen page.
 * Uses IndexedDB as primary with automatic fallback to chrome.storage.local
 * and memory store to ensure bulletproof operation even in restricted/sandboxed contexts.
 */
export class IndexedDbMediaTransferStore implements MediaTransferStore {
  private databasePromise: Promise<IDBDatabase> | null = null;

  async stage(file: File): Promise<string> {
    if (!isTransferEntry({ transferId: "pending", file, createdAt: Date.now() })) {
      throw new MediaEngineError("MEDIA_TRANSFER_FAILED", "The selected file cannot be staged for local processing.");
    }
    await this.clearExpired();
    const transferId = generateTransferId();

    // 1. Attempt IndexedDB write
    try {
      const database = await this.openDatabase();
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, "readwrite");
        transaction.objectStore(STORE_NAME).put({ transferId, file, createdAt: Date.now() } satisfies TransferEntry);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB write transaction failed."));
        transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB write transaction was aborted."));
      });
      return transferId;
    } catch {
      // 2. Fallback to chrome.storage.local if available
      if (typeof chrome !== "undefined" && chrome.storage?.local) {
        try {
          const base64 = await fileToBase64(file);
          const entry: SerializedTransferEntry = {
            transferId,
            name: file.name,
            type: file.type,
            lastModified: file.lastModified,
            base64,
            createdAt: Date.now(),
          };
          await chrome.storage.local.set({ [`${STORAGE_PREFIX}${transferId}`]: entry });
          return transferId;
        } catch {
          // Fall through to in-memory fallback
        }
      }

      // 3. In-memory fallback
      memoryFallback.set(transferId, { transferId, file, createdAt: Date.now() });
      return transferId;
    }
  }

  async take(transferId: string): Promise<File> {
    if (!/^transfer_[A-Za-z0-9-]{8,100}$/.test(transferId)) {
      throw new MediaEngineError("MEDIA_TRANSFER_FAILED", "The local transfer ID is invalid.");
    }

    // 1. Try IndexedDB
    try {
      const database = await this.openDatabase();
      const file = await new Promise<File | null>((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, "readwrite");
        const store = transaction.objectStore(STORE_NAME);
        const request = store.get(transferId);
        let foundFile: File | null = null;
        let missing = false;
        request.onsuccess = () => {
          const entry: unknown = request.result;
          if (!isTransferEntry(entry) || isExpiredMediaTransfer(entry.createdAt)) {
            missing = true;
            store.delete(transferId);
            return;
          }
          foundFile = entry.file;
          store.delete(transferId);
        };
        request.onerror = () => reject(request.error ?? new Error("IndexedDB transfer lookup failed."));
        transaction.oncomplete = () => {
          if (foundFile !== null && !missing) resolve(foundFile);
          else resolve(null);
        };
        transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transfer read failed."));
        transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transfer read was aborted."));
      });
      if (file !== null) return file;
    } catch {
      // IDB unavailable / failed - check storage/memory fallbacks below
    }

    // 2. Try chrome.storage.local
    if (typeof chrome !== "undefined" && chrome.storage?.local) {
      try {
        const key = `${STORAGE_PREFIX}${transferId}`;
        const items = await chrome.storage.local.get(key);
        const entry = items[key] as SerializedTransferEntry | undefined;
        if (entry && !isExpiredMediaTransfer(entry.createdAt)) {
          await chrome.storage.local.remove(key);
          return base64ToFile(entry.base64, entry.name, entry.type, entry.lastModified);
        }
        if (entry) {
          await chrome.storage.local.remove(key);
        }
      } catch {
        // Fall through to in-memory
      }
    }

    // 3. Try memory fallback
    const memEntry = memoryFallback.get(transferId);
    if (memEntry !== undefined) {
      memoryFallback.delete(transferId);
      if (!isExpiredMediaTransfer(memEntry.createdAt)) {
        return memEntry.file;
      }
    }

    throw new MediaEngineError("MEDIA_TRANSFER_FAILED", "The local file handoff expired or was not found.");
  }

  async delete(transferId: string): Promise<void> {
    memoryFallback.delete(transferId);

    if (typeof chrome !== "undefined" && chrome.storage?.local) {
      try {
        await chrome.storage.local.remove(`${STORAGE_PREFIX}${transferId}`);
      } catch {
        // Ignore cleanup errors
      }
    }

    try {
      const database = await this.openDatabase();
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, "readwrite");
        transaction.objectStore(STORE_NAME).delete(transferId);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transfer cleanup failed."));
        transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transfer cleanup was aborted."));
      });
    } catch {
      // Ignore cleanup errors
    }
  }

  async clearExpired(): Promise<number> {
    let removed = 0;
    const now = Date.now();

    // Memory sweep
    for (const [id, entry] of memoryFallback.entries()) {
      if (isExpiredMediaTransfer(entry.createdAt, now)) {
        memoryFallback.delete(id);
        removed += 1;
      }
    }

    // chrome.storage sweep
    if (typeof chrome !== "undefined" && chrome.storage?.local) {
      try {
        const allItems = await chrome.storage.local.get(null);
        const removeKeys: string[] = [];
        for (const [key, value] of Object.entries(allItems)) {
          if (key.startsWith(STORAGE_PREFIX)) {
            const entry = value as SerializedTransferEntry;
            if (!entry || isExpiredMediaTransfer(entry.createdAt, now)) {
              removeKeys.push(key);
              removed += 1;
            }
          }
        }
        if (removeKeys.length > 0) {
          await chrome.storage.local.remove(removeKeys);
        }
      } catch {
        // Ignore sweep errors
      }
    }

    // IndexedDB sweep
    try {
      const database = await this.openDatabase();
      const idbRemoved = await new Promise<number>((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, "readwrite");
        const request = transaction.objectStore(STORE_NAME).openCursor();
        let idbCount = 0;
        request.onsuccess = () => {
          const cursor = request.result;
          if (cursor === null) return;
          const entry: unknown = cursor.value;
          if (!isTransferEntry(entry) || isExpiredMediaTransfer(entry.createdAt, now)) {
            cursor.delete();
            idbCount += 1;
          }
          cursor.continue();
        };
        request.onerror = () => reject(request.error ?? new Error("IndexedDB expiry sweep failed."));
        transaction.oncomplete = () => resolve(idbCount);
        transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB expiry transaction failed."));
        transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB expiry transaction was aborted."));
      });
      removed += idbRemoved;
    } catch {
      // Ignore sweep errors
    }

    return removed;
  }

  async close(): Promise<void> {
    if (this.databasePromise === null) return;
    try {
      const database = await this.databasePromise;
      database.close();
    } catch {
      // Ignore close error
    } finally {
      this.databasePromise = null;
    }
  }

  private openDatabase(): Promise<IDBDatabase> {
    if (typeof indexedDB === "undefined") {
      return Promise.reject(new MediaEngineError("MEDIA_TRANSFER_FAILED", "IndexedDB is unavailable in this extension context."));
    }
    if (this.databasePromise !== null) return this.databasePromise;
    this.databasePromise = new Promise<IDBDatabase>((resolve, reject) => {
      let request: IDBOpenDBRequest;
      try {
        request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
      } catch (err) {
        reject(err);
        return;
      }
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(STORE_NAME)) {
          database.createObjectStore(STORE_NAME, { keyPath: "transferId" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("Could not open local media transfer storage."));
      request.onblocked = () => reject(new Error("Local media transfer storage upgrade is blocked."));
    }).catch((error: unknown) => {
      this.databasePromise = null;
      throw error;
    });
    return this.databasePromise;
  }
}
