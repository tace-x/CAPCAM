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

const DATABASE_NAME = "capcam-media-transfer-v1";
const DATABASE_VERSION = 1;
const STORE_NAME = "pending-files";

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

function transferFailure(error: unknown): MediaEngineError {
  if (error instanceof MediaEngineError) return error;
  return new MediaEngineError("MEDIA_TRANSFER_FAILED", undefined, {
    reason: error instanceof Error ? error.message : "IndexedDB transfer failed.",
  });
}

/**
 * Short-lived local File handoff between popup and offscreen page. Files are taken/deleted
 * before decode; expired handoffs are swept. This is not a persistent media library.
 */
export class IndexedDbMediaTransferStore implements MediaTransferStore {
  private databasePromise: Promise<IDBDatabase> | null = null;

  async stage(file: File): Promise<string> {
    if (!isTransferEntry({ transferId: "pending", file, createdAt: Date.now() })) {
      throw new MediaEngineError("MEDIA_TRANSFER_FAILED", "The selected file cannot be staged for local processing.");
    }
    try {
      await this.clearExpired();
      const transferId = generateTransferId();
      const database = await this.openDatabase();
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, "readwrite");
        transaction.objectStore(STORE_NAME).put({ transferId, file, createdAt: Date.now() } satisfies TransferEntry);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB write transaction failed."));
        transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB write transaction was aborted."));
      });
      return transferId;
    } catch (error) {
      throw transferFailure(error);
    }
  }

  async take(transferId: string): Promise<File> {
    if (!/^transfer_[A-Za-z0-9-]{8,100}$/.test(transferId)) {
      throw new MediaEngineError("MEDIA_TRANSFER_FAILED", "The local transfer ID is invalid.");
    }
    try {
      const database = await this.openDatabase();
      return await new Promise<File>((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, "readwrite");
        const store = transaction.objectStore(STORE_NAME);
        const request = store.get(transferId);
        let file: File | null = null;
        let missing = false;
        request.onsuccess = () => {
          const entry: unknown = request.result;
          if (!isTransferEntry(entry) || isExpiredMediaTransfer(entry.createdAt)) {
            missing = true;
            store.delete(transferId);
            return;
          }
          file = entry.file;
          store.delete(transferId);
        };
        request.onerror = () => reject(request.error ?? new Error("IndexedDB transfer lookup failed."));
        transaction.oncomplete = () => {
          if (file !== null && !missing) resolve(file);
          else reject(new MediaEngineError("MEDIA_TRANSFER_FAILED", "The local file handoff expired or was not found."));
        };
        transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transfer read failed."));
        transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transfer read was aborted."));
      });
    } catch (error) {
      throw transferFailure(error);
    }
  }

  async delete(transferId: string): Promise<void> {
    try {
      const database = await this.openDatabase();
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, "readwrite");
        transaction.objectStore(STORE_NAME).delete(transferId);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transfer cleanup failed."));
        transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transfer cleanup was aborted."));
      });
    } catch (error) {
      throw transferFailure(error);
    }
  }

  async clearExpired(): Promise<number> {
    try {
      const database = await this.openDatabase();
      const now = Date.now();
      return await new Promise<number>((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, "readwrite");
        const request = transaction.objectStore(STORE_NAME).openCursor();
        let removed = 0;
        request.onsuccess = () => {
          const cursor = request.result;
          if (cursor === null) return;
          const entry: unknown = cursor.value;
          if (!isTransferEntry(entry) || isExpiredMediaTransfer(entry.createdAt, now)) {
            cursor.delete();
            removed += 1;
          }
          cursor.continue();
        };
        request.onerror = () => reject(request.error ?? new Error("IndexedDB expiry sweep failed."));
        transaction.oncomplete = () => resolve(removed);
        transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB expiry transaction failed."));
        transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB expiry transaction was aborted."));
      });
    } catch (error) {
      throw transferFailure(error);
    }
  }

  async close(): Promise<void> {
    if (this.databasePromise === null) return;
    const database = await this.databasePromise;
    database.close();
    this.databasePromise = null;
  }

  private openDatabase(): Promise<IDBDatabase> {
    if (typeof indexedDB === "undefined") {
      return Promise.reject(new MediaEngineError("MEDIA_TRANSFER_FAILED", "IndexedDB is unavailable in this extension context."));
    }
    if (this.databasePromise !== null) return this.databasePromise;
    this.databasePromise = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
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
