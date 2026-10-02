import { CapCamError } from "../shared/errors";
import { createLogger } from "../shared/logger";
import { createEvent, type EventEnvelope, type EventMap, type EventType } from "../messaging/events";
import { calculateAspectRatio } from "./aspect-ratio";
import { MediaEngineError, toMediaEngineError } from "./media-errors";
import { generateMediaId } from "./media-ids";
import { MediaRegistry } from "./media-registry";
import { transitionMediaStatus } from "./media-lifecycle";
import { detectMediaFormat } from "./mime-detection";
import { ObjectUrlManager } from "./object-url-manager";
import { ImageMediaSource, VideoMediaSource, type MediaSource } from "./media-source";
import { ImageResourceManager, type ImageResourceManagerPort } from "./image-resource-manager";
import { VideoResourceManager, type VideoResourceManagerPort } from "./video-resource-manager";
import { CAPCAM_MAX_MEDIA_SIZE_BYTES, IMAGE_LOAD_TIMEOUT_MS, MAX_CONCURRENT_MEDIA_LOADS, VIDEO_LOAD_TIMEOUT_MS } from "./media-limits";
import { IndexedDbMediaTransferStore, type MediaTransferStore } from "./media-transfer-store";
import type { ImageResourceInfo, MediaClearResult, MediaKind, MediaRecord, MediaStatus, VideoResourceInfo } from "./media-types";
import { isTransferId } from "./media-validation";

const logger = createLogger("Media");

type EventPublisher = (event: EventEnvelope) => void;

interface LoadJob {
  controller: AbortController;
  finished: Promise<void>;
  finish: () => void;
  removeRequested: boolean;
}

interface LoadSlotWaiter {
  job: LoadJob;
  resolve: (release: () => void) => void;
  reject: (error: MediaEngineError) => void;
  onAbort: () => void;
}

export interface MediaEngineOptions {
  transferStore?: MediaTransferStore;
  registry?: MediaRegistry;
  objectUrls?: ObjectUrlManager;
  imageResources?: ImageResourceManagerPort;
  videoResources?: VideoResourceManagerPort;
  maxMediaSizeBytes?: number;
  maxConcurrentLoads?: number;
  imageTimeoutMs?: number;
  videoTimeoutMs?: number;
  createMediaId?: () => string;
  publishEvent?: EventPublisher;
}

function makeLoadJob(): LoadJob {
  let finish = (): void => undefined;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  return { controller: new AbortController(), finished, finish, removeRequested: false };
}

function safeName(name: string, kind: MediaKind): string {
  const cleaned = name.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 255);
  return cleaned.length > 0 ? cleaned : `Untitled ${kind}`;
}

function emptyRecord(id: string, file: File, kind: MediaKind, mimeType: string): MediaRecord {
  return {
    id,
    name: safeName(file.name, kind),
    kind,
    mimeType,
    size: file.size,
    width: null,
    height: null,
    aspectRatio: null,
    duration: null,
    sourceUrl: null,
    createdAt: Date.now(),
    status: "NEW",
    capabilities: { canDecode: false, canSeek: false, supportsAudio: false },
  };
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

function createSource(
  record: MediaRecord,
  sourceUrl: string,
  releaseResource: () => Promise<void>,
): MediaSource {
  if (record.kind === "image") {
    return new ImageMediaSource(record.id, record.name, record.mimeType, record.size, sourceUrl, releaseResource);
  }
  return new VideoMediaSource(record.id, record.name, record.mimeType, record.size, sourceUrl, releaseResource);
}

function mediaErrorForFile(error: unknown, formatRequiresDecodeConfirmation: boolean): MediaEngineError {
  const failure = toMediaEngineError(error);
  if (formatRequiresDecodeConfirmation && failure.mediaCode === "MEDIA_DECODE_FAILED") {
    return new MediaEngineError("MEDIA_UNSUPPORTED_TYPE", "This additional image format was not confirmed by Chrome's decoder.", {
      causeCode: failure.mediaCode,
    });
  }
  return failure;
}

export class MediaEngine {
  readonly registry: MediaRegistry;
  readonly objectUrls: ObjectUrlManager;
  readonly imageResources: ImageResourceManagerPort;
  readonly videoResources: VideoResourceManagerPort;
  private readonly transferStore: MediaTransferStore;
  private readonly maxMediaSizeBytes: number;
  private readonly maxConcurrentLoads: number;
  private readonly imageTimeoutMs: number;
  private readonly videoTimeoutMs: number;
  private readonly createId: () => string;
  private readonly publishEvent?: EventPublisher;
  private readonly jobs = new Map<string, LoadJob>();
  private readonly removalTasks = new Map<string, Promise<MediaRecord>>();
  private readonly loadSlotWaiters: LoadSlotWaiter[] = [];
  private activeLoads = 0;
  private initialized = false;

  constructor(options: MediaEngineOptions = {}) {
    this.registry = options.registry ?? new MediaRegistry();
    this.objectUrls = options.objectUrls ?? new ObjectUrlManager();
    this.imageResources = options.imageResources ?? new ImageResourceManager();
    this.videoResources = options.videoResources ?? new VideoResourceManager();
    this.transferStore = options.transferStore ?? new IndexedDbMediaTransferStore();
    this.maxMediaSizeBytes = options.maxMediaSizeBytes ?? CAPCAM_MAX_MEDIA_SIZE_BYTES;
    this.maxConcurrentLoads = options.maxConcurrentLoads ?? MAX_CONCURRENT_MEDIA_LOADS;
    this.imageTimeoutMs = options.imageTimeoutMs ?? IMAGE_LOAD_TIMEOUT_MS;
    this.videoTimeoutMs = options.videoTimeoutMs ?? VIDEO_LOAD_TIMEOUT_MS;
    this.createId = options.createMediaId ?? generateMediaId;
    if (options.publishEvent !== undefined) this.publishEvent = options.publishEvent;
    if (!Number.isFinite(this.maxMediaSizeBytes) || this.maxMediaSizeBytes <= 0) {
      throw new MediaEngineError("MEDIA_INVALID_FILE", "The configured media size limit must be a positive number.");
    }
    if (!Number.isInteger(this.maxConcurrentLoads) || this.maxConcurrentLoads < 1) {
      throw new MediaEngineError("MEDIA_INVALID_FILE", "The concurrent media load limit must be a positive integer.");
    }
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.transferStore.clearExpired();
    this.initialized = true;
    logger.info("Media engine ready.");
  }

  async register(transferId: string): Promise<MediaRecord> {
    if (!this.initialized) {
      throw new CapCamError("CAPCAM_RUNTIME_ERROR", "Media engine is not initialized.");
    }
    if (!isTransferId(transferId)) {
      throw new MediaEngineError("MEDIA_TRANSFER_FAILED", "The local file handoff ID is invalid.");
    }

    const mediaId = this.nextMediaId();
    const job = makeLoadJob();
    this.jobs.set(mediaId, job);
    try {
      return await this.loadTransferredFile(mediaId, transferId, job);
    } finally {
      this.jobs.delete(mediaId);
      job.finish();
    }
  }

  get(mediaId: string): MediaRecord {
    const record = this.registry.get(mediaId);
    if (record === undefined) throw new MediaEngineError("MEDIA_NOT_FOUND", undefined, { mediaId });
    if (record.status === "RELEASED") throw new MediaEngineError("MEDIA_RELEASED", undefined, { mediaId });
    return record;
  }

  list(): MediaRecord[] {
    return this.registry.list();
  }

  inspect(mediaId: string): MediaRecord {
    return this.get(mediaId);
  }

  has(mediaId: string): boolean {
    return this.registry.has(mediaId);
  }

  remove(mediaId: string): Promise<MediaRecord> {
    const existing = this.removalTasks.get(mediaId);
    if (existing !== undefined) return existing;
    const operation = Promise.resolve().then(() => this.removeInternal(mediaId)).finally(() => {
      this.removalTasks.delete(mediaId);
    });
    this.removalTasks.set(mediaId, operation);
    return operation;
  }

  private async removeInternal(mediaId: string): Promise<MediaRecord> {
    const job = this.jobs.get(mediaId);
    if (job !== undefined) {
      job.removeRequested = true;
      const existing = this.registry.get(mediaId);
      if (existing !== undefined && existing.status !== "RELEASING") {
        this.updateStatus(existing, "RELEASING");
      }
      job.controller.abort();
      await job.finished;
    }

    const current = this.registry.get(mediaId);
    if (current === undefined) throw new MediaEngineError("MEDIA_NOT_FOUND", undefined, { mediaId });
    const record = current.status === "RELEASING" ? current : this.updateStatus(current, "RELEASING");
    const source = this.registry.getSource(mediaId);
    let cleanupFailure: unknown;

    try {
      if (source !== undefined) await source.release();
    } catch (error) {
      cleanupFailure = error;
      logger.warn("A media resource manager reported a release failure.", { mediaId, kind: record.kind });
    }

    if (record.sourceUrl !== null) {
      try {
        this.objectUrls.revoke(record.sourceUrl);
      } catch (error) {
        cleanupFailure ??= error;
        logger.warn("A media object URL could not be revoked cleanly.", { mediaId });
      }
    }

    const released: MediaRecord = { ...record, status: transitionMediaStatus(record.status, "RELEASED"), sourceUrl: null };
    this.registry.update(released);
    this.emit("media.released", { mediaId, record: cloneRecord(released) });
    this.registry.remove(mediaId);
    this.emit("media.removed", { mediaId });
    if (cleanupFailure !== undefined) throw toMediaEngineError(cleanupFailure, "MEDIA_RESOURCE_FAILED");
    return cloneRecord(released);
  }

  async clear(): Promise<MediaClearResult> {
    const jobs = Array.from(this.jobs.entries());
    for (const [, job] of jobs) {
      job.removeRequested = true;
      job.controller.abort();
    }
    await Promise.all(jobs.map(([, job]) => job.finished));

    const ids = this.registry.list().map((record) => record.id);
    let removed = 0;
    for (const mediaId of ids) {
      try {
        await this.remove(mediaId);
        removed += 1;
      } catch (error) {
        if (!this.registry.has(mediaId)) removed += 1;
        logger.warn("Media clear could not release an item.", { mediaId, code: toMediaEngineError(error, "MEDIA_RESOURCE_FAILED").mediaCode });
      }
    }
    return { removed };
  }

  async shutdown(): Promise<void> {
    if (!this.initialized && this.registry.size === 0 && this.jobs.size === 0) return;
    this.initialized = false;
    await this.clear();
    try {
      this.objectUrls.revokeAll();
    } catch (error) {
      logger.warn("Some tracked Blob URLs could not be revoked during shutdown.", {
        code: toMediaEngineError(error, "MEDIA_RESOURCE_FAILED").mediaCode,
      });
    }
    logger.info("Media engine stopped.");
  }

  private acquireLoadSlot(job: LoadJob): Promise<() => void> {
    if (job.controller.signal.aborted) return Promise.reject(new MediaEngineError("MEDIA_CANCELLED"));
    if (this.activeLoads < this.maxConcurrentLoads) {
      this.activeLoads += 1;
      return Promise.resolve(this.makeLoadSlotRelease());
    }

    return new Promise<() => void>((resolve, reject) => {
      let waiter: LoadSlotWaiter;
      const onAbort = (): void => {
        const index = this.loadSlotWaiters.indexOf(waiter);
        if (index >= 0) this.loadSlotWaiters.splice(index, 1);
        job.controller.signal.removeEventListener("abort", onAbort);
        reject(new MediaEngineError("MEDIA_CANCELLED"));
      };
      waiter = {
        job,
        resolve: (release) => {
          job.controller.signal.removeEventListener("abort", onAbort);
          resolve(release);
        },
        reject: (error) => {
          job.controller.signal.removeEventListener("abort", onAbort);
          reject(error);
        },
        onAbort,
      };
      this.loadSlotWaiters.push(waiter);
      job.controller.signal.addEventListener("abort", onAbort, { once: true });
      if (job.controller.signal.aborted) onAbort();
    });
  }

  private makeLoadSlotRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeLoads -= 1;
      this.grantNextLoadSlot();
    };
  }

  private grantNextLoadSlot(): void {
    while (this.activeLoads < this.maxConcurrentLoads && this.loadSlotWaiters.length > 0) {
      const waiter = this.loadSlotWaiters.shift();
      if (waiter === undefined) return;
      waiter.job.controller.signal.removeEventListener("abort", waiter.onAbort);
      if (waiter.job.controller.signal.aborted) {
        waiter.reject(new MediaEngineError("MEDIA_CANCELLED"));
        continue;
      }
      this.activeLoads += 1;
      waiter.resolve(this.makeLoadSlotRelease());
    }
  }

  private async loadTransferredFile(mediaId: string, transferId: string, job: LoadJob): Promise<MediaRecord> {
    let file: File;
    try {
      file = await this.transferStore.take(transferId);
    } catch (error) {
      throw toMediaEngineError(error, "MEDIA_TRANSFER_FAILED");
    }
    if (job.removeRequested || job.controller.signal.aborted) throw new MediaEngineError("MEDIA_CANCELLED");
    if (!Number.isFinite(file.size) || file.size <= 0) throw new MediaEngineError("MEDIA_INVALID_FILE");
    if (file.size > this.maxMediaSizeBytes) {
      throw new MediaEngineError("MEDIA_TOO_LARGE", undefined, { size: file.size, maxSize: this.maxMediaSizeBytes });
    }

    let header: Uint8Array;
    try {
      header = new Uint8Array(await file.slice(0, 64).arrayBuffer());
    } catch (error) {
      throw new MediaEngineError("MEDIA_INVALID_FILE", undefined, {
        reason: error instanceof Error ? error.message : "Unable to inspect the file signature.",
      });
    }
    const format = detectMediaFormat(file.type, header);
    const initial = emptyRecord(mediaId, file, format.kind, format.mimeType);
    this.registry.register(initial);
    this.emit("media.registered", { mediaId, record: cloneRecord(initial) });
    let record = this.updateStatus(initial, "VALIDATING");
    let sourceUrl: string | null = null;
    let source: MediaSource | undefined;
    let releaseLoadSlot: (() => void) | undefined;

    try {
      if (job.removeRequested || job.controller.signal.aborted) throw new MediaEngineError("MEDIA_CANCELLED");
      releaseLoadSlot = await this.acquireLoadSlot(job);
      if (job.removeRequested || job.controller.signal.aborted) throw new MediaEngineError("MEDIA_CANCELLED");
      sourceUrl = this.objectUrls.create(file);
      record = { ...record, sourceUrl };
      this.registry.update(record);
      source = createSource(record, sourceUrl, () => this.releaseResourceByKind(record.kind, mediaId));
      this.registry.attachSource(mediaId, source);
      record = this.updateStatus(record, "LOADING");
      this.emit("media.loading", { mediaId, record: cloneRecord(record) });

      const metadata = record.kind === "image"
        ? await this.imageResources.load(mediaId, sourceUrl, job.controller.signal, this.imageTimeoutMs)
        : await this.videoResources.load(mediaId, sourceUrl, record.mimeType, job.controller.signal, this.videoTimeoutMs);
      if (job.removeRequested || job.controller.signal.aborted || !this.registry.has(mediaId)) {
        throw new MediaEngineError("MEDIA_CANCELLED");
      }
      const ready = this.makeReadyRecord(record, metadata);
      this.registry.update(ready);
      this.emit("media.ready", { mediaId, record: cloneRecord(ready) });
      logger.debug("Local media is ready.", { mediaId, kind: ready.kind, size: ready.size });
      return cloneRecord(ready);
    } catch (error) {
      releaseLoadSlot?.();
      releaseLoadSlot = undefined;
      if (job.removeRequested || job.controller.signal.aborted) {
        // The remover owns final cleanup after the load job settles.
        throw new MediaEngineError("MEDIA_CANCELLED", "Media loading was cancelled because the item was removed.", { mediaId });
      }

      const failure = mediaErrorForFile(error, format.requiresDecodeConfirmation);
      await this.cleanupFailedLoad(mediaId, sourceUrl, source);
      const existing = this.registry.get(mediaId);
      if (existing !== undefined && existing.status !== "RELEASING") {
        const errorInfo = failure.toInfo();
        const failed = {
          ...existing,
          status: transitionMediaStatus(existing.status, "ERROR"),
          sourceUrl: null,
          capabilities: { canDecode: false, canSeek: false, supportsAudio: false },
          error: errorInfo,
        } satisfies MediaRecord;
        this.registry.update(failed);
        this.emit("media.failed", { mediaId, record: cloneRecord(failed), error: errorInfo });
      }
      throw failure;
    } finally {
      releaseLoadSlot?.();
    }
  }

  private makeReadyRecord(
    record: MediaRecord,
    metadata: ImageResourceInfo | VideoResourceInfo,
  ): MediaRecord {
    const readyStatus: MediaStatus = transitionMediaStatus(record.status, "READY");
    const isVideo = record.kind === "video";
    const videoMetadata = isVideo ? metadata as VideoResourceInfo : undefined;
    return {
      ...record,
      status: readyStatus,
      width: metadata.width,
      height: metadata.height,
      aspectRatio: calculateAspectRatio(metadata.width, metadata.height),
      duration: videoMetadata?.duration ?? null,
      capabilities: {
        canDecode: true,
        canSeek: videoMetadata?.canSeek ?? false,
        supportsAudio: videoMetadata?.supportsAudio ?? false,
      },
    };
  }

  private updateStatus(record: MediaRecord, status: MediaStatus): MediaRecord {
    const updated: MediaRecord = { ...record, status: transitionMediaStatus(record.status, status) };
    this.registry.update(updated);
    return updated;
  }

  private async cleanupFailedLoad(mediaId: string, sourceUrl: string | null, source?: MediaSource): Promise<void> {
    try {
      if (source !== undefined) await source.release();
    } catch (error) {
      logger.warn("Failed media resource cleanup was incomplete.", {
        mediaId,
        code: toMediaEngineError(error, "MEDIA_RESOURCE_FAILED").mediaCode,
      });
    }
    if (sourceUrl !== null) {
      try {
        this.objectUrls.revoke(sourceUrl);
      } catch {
        logger.warn("Failed media Blob URL cleanup was incomplete.", { mediaId });
      }
    }
    this.registry.detachSource(mediaId);
  }

  private async releaseResourceByKind(kind: MediaKind, mediaId: string): Promise<void> {
    if (kind === "image") await this.imageResources.releaseImage(mediaId);
    else await this.videoResources.releaseVideo(mediaId);
  }

  private nextMediaId(): string {
    let mediaId = this.createId();
    let attempts = 0;
    while ((this.registry.has(mediaId) || this.jobs.has(mediaId)) && attempts < 5) {
      mediaId = this.createId();
      attempts += 1;
    }
    if (this.registry.has(mediaId) || this.jobs.has(mediaId)) {
      throw new MediaEngineError("MEDIA_INVALID_STATE", "Could not allocate a unique media ID.");
    }
    return mediaId;
  }

  private emit<T extends EventType>(type: T, payload: EventMap[T]): void {
    if (this.publishEvent === undefined) return;
    try {
      this.publishEvent(createEvent(type, payload));
    } catch (error) {
      logger.warn("A media lifecycle event could not be published.", {
        type,
        code: error instanceof CapCamError ? error.code : "CAPCAM_RUNTIME_ERROR",
      });
    }
  }
}
