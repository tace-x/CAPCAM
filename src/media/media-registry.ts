import { MediaEngineError } from "./media-errors";
import type { MediaSource } from "./media-source";
import type { MediaRecord } from "./media-types";
import { isMediaRecord } from "./media-validation";

interface MediaRegistryEntry {
  record: MediaRecord;
  source?: MediaSource;
}

function cloneRecord(record: MediaRecord): MediaRecord {
  return {
    ...record,
    capabilities: { ...record.capabilities },
    ...(record.error === undefined
      ? {}
      : { error: { ...record.error, ...(record.error.details === undefined ? {} : { details: { ...record.error.details } }) } }),
  };
}

export class MediaRegistry {
  private readonly entries = new Map<string, MediaRegistryEntry>();

  register(record: MediaRecord, source?: MediaSource): MediaRecord {
    if (!isMediaRecord(record) || (source !== undefined && source.id !== record.id)) {
      throw new MediaEngineError("MEDIA_INVALID_FILE", "Media registry entry is invalid.");
    }
    if (this.entries.has(record.id)) {
      throw new MediaEngineError("MEDIA_INVALID_FILE", "A media item with this ID is already registered.", { mediaId: record.id });
    }
    const entry: MediaRegistryEntry = { record: cloneRecord(record) };
    if (source !== undefined) entry.source = source;
    this.entries.set(record.id, entry);
    return cloneRecord(entry.record);
  }

  update(record: MediaRecord): MediaRecord {
    if (!isMediaRecord(record)) {
      throw new MediaEngineError("MEDIA_INVALID_FILE", "Updated media record is invalid.");
    }
    const existing = this.entries.get(record.id);
    if (existing === undefined) {
      throw new MediaEngineError("MEDIA_NOT_FOUND", undefined, { mediaId: record.id });
    }
    existing.record = cloneRecord(record);
    return cloneRecord(existing.record);
  }

  attachSource(mediaId: string, source: MediaSource): void {
    const existing = this.entries.get(mediaId);
    if (existing === undefined) throw new MediaEngineError("MEDIA_NOT_FOUND", undefined, { mediaId });
    if (source.id !== mediaId || source.kind !== existing.record.kind) {
      throw new MediaEngineError("MEDIA_INVALID_FILE", "Media source does not match its registry record.", { mediaId });
    }
    existing.source = source;
  }

  get(mediaId: string): MediaRecord | undefined {
    const entry = this.entries.get(mediaId);
    return entry === undefined ? undefined : cloneRecord(entry.record);
  }

  getSource(mediaId: string): MediaSource | undefined {
    return this.entries.get(mediaId)?.source;
  }

  detachSource(mediaId: string): void {
    const entry = this.entries.get(mediaId);
    if (entry !== undefined) delete entry.source;
  }

  list(): MediaRecord[] {
    return Array.from(this.entries.values(), ({ record }) => cloneRecord(record));
  }

  remove(mediaId: string): MediaRecord | undefined {
    const entry = this.entries.get(mediaId);
    if (entry === undefined) return undefined;
    this.entries.delete(mediaId);
    return cloneRecord(entry.record);
  }

  clear(): MediaRecord[] {
    const records = this.list();
    this.entries.clear();
    return records;
  }

  has(mediaId: string): boolean {
    return this.entries.has(mediaId);
  }

  get size(): number {
    return this.entries.size;
  }
}
