import { isMediaId } from "../media/media-validation";
import { createLogger } from "../shared/logger";
import { createPlaybackEvent, type PlaybackEventType } from "./playback-events";
import { PlaybackEngineError, toPlaybackEngineError } from "./playback-errors";
import { generatePlaybackId } from "./playback-ids";
import { PlaybackController, type PlaybackControllerDependencies } from "./playback-controller";
import type { PlaybackEventEnvelope } from "./playback-events";
import type {
  PlaybackControllerPort,
  PlaybackIdPayload,
  PlaybackLoadRequest,
  PlaybackLoopRequest,
  PlaybackRateRequest,
  PlaybackRecord,
  PlaybackSeekRequest,
  PlaybackSourceProvider,
} from "./playback-types";

const logger = createLogger("Playback");
const MAX_IMAGE_DURATION_SECONDS = 24 * 60 * 60;
type EventPublisher = (event: PlaybackEventEnvelope) => void;

export interface PlaybackEngineOptions {
  createPlaybackId?: () => string;
  publishEvent?: EventPublisher;
  controllerDependencies?: PlaybackControllerDependencies;
  now?: () => number;
}

function cloneRecord(record: PlaybackRecord | null): PlaybackRecord | null {
  if (record === null) return null;
  return {
    ...record,
    error: record.error === null
      ? null
      : { ...record.error, ...(record.error.details === undefined ? {} : { details: { ...record.error.details } }) },
  };
}

function videoDuration(source: ReturnType<PlaybackSourceProvider["getRenderableSource"]>): number | null {
  if (source.kind !== "video") return null;
  const duration = source.element.duration;
  return Number.isFinite(duration) && duration >= 0 ? duration : null;
}

export class PlaybackEngine {
  private controller: PlaybackControllerPort | null = null;
  private lastRecord: PlaybackRecord | null = null;
  private lifecycleQueue: Promise<void> = Promise.resolve();
  private readonly allocatedIds = new Set<string>();
  private readonly createId: () => string;
  private readonly publishEvent: EventPublisher | undefined;
  private readonly now: () => number;

  constructor(
    private readonly sourceProvider: PlaybackSourceProvider,
    options: PlaybackEngineOptions = {},
  ) {
    this.createId = options.createPlaybackId ?? generatePlaybackId;
    this.publishEvent = options.publishEvent;
    this.now = options.now ?? Date.now;
    this.controllerDependencies = options.controllerDependencies ?? {};
  }

  private readonly controllerDependencies: PlaybackControllerDependencies;

  getState(): PlaybackRecord | null {
    return cloneRecord(this.controller?.getState() ?? this.lastRecord);
  }

  getActiveCount(): number {
    return this.controller === null ? 0 : 1;
  }

  load(request: PlaybackLoadRequest): Promise<PlaybackRecord> {
    return this.serializeLifecycle(() => this.loadInternal(request));
  }

  private async loadInternal(request: PlaybackLoadRequest): Promise<PlaybackRecord> {
    if (!isMediaId(request.mediaId)) throw new PlaybackEngineError("PLAYBACK_MEDIA_NOT_FOUND", undefined, { mediaId: request.mediaId });
    if (request.imageDurationSeconds !== undefined &&
      (!Number.isFinite(request.imageDurationSeconds) || request.imageDurationSeconds <= 0 || request.imageDurationSeconds > MAX_IMAGE_DURATION_SECONDS)) {
      throw new PlaybackEngineError("PLAYBACK_INVALID_TIME", "Image duration must be a finite value greater than zero and at most 24 hours.", {
        imageDurationSeconds: request.imageDurationSeconds,
      });
    }

    const existing = this.getState();
    if (this.controller !== null && existing?.mediaId === request.mediaId && existing.state !== "ERROR" &&
      (existing.kind === "video" || existing.duration === (request.imageDurationSeconds ?? null))) {
      return existing;
    }

    const previousController = this.controller;
    if (previousController !== null) {
      const previous = previousController.dispose();
      this.controller = null;
      this.lastRecord = previous;
      this.emit("playback.disposed", previous);
    }

    const playbackId = this.allocatePlaybackId();
    const initial: PlaybackRecord = {
      playbackId,
      mediaId: request.mediaId,
      kind: null,
      state: "LOADING",
      currentTime: 0,
      duration: null,
      playbackRate: 1,
      loop: false,
      startedAt: null,
      updatedAt: this.now(),
      error: null,
    };
    this.lastRecord = initial;
    this.emit("playback.loading", initial);

    let source: ReturnType<PlaybackSourceProvider["getRenderableSource"]>;
    try {
      source = this.sourceProvider.getRenderableSource(request.mediaId);
    } catch (error) {
      const failure = toPlaybackEngineError(error, "PLAYBACK_MEDIA_NOT_FOUND");
      this.lastRecord = { ...initial, state: "ERROR", updatedAt: this.now(), error: failure.toInfo() };
      this.emit("playback.error", this.lastRecord);
      throw failure;
    }

    const duration = source.kind === "image" ? request.imageDurationSeconds ?? null : videoDuration(source);
    const loadedRecord: PlaybackRecord = { ...initial, kind: source.kind, duration };
    let controller: PlaybackControllerPort | null = null;
    try {
      controller = new PlaybackController(
        loadedRecord,
        source,
        (type, record) => this.handleControllerEvent(controller, type, record),
        this.controllerDependencies,
      );
      this.controller = controller;
      this.lastRecord = loadedRecord;
      return await controller.load();
    } catch (error) {
      const failure = toPlaybackEngineError(error, "PLAYBACK_LOAD_FAILED");
      if (controller !== null) {
        this.lastRecord = controller.getState();
        this.controller = controller;
      } else {
        this.lastRecord = { ...loadedRecord, state: "ERROR", updatedAt: this.now(), error: failure.toInfo() };
        this.emit("playback.error", this.lastRecord);
      }
      throw failure;
    }
  }

  play(payload: PlaybackIdPayload): Promise<PlaybackRecord> {
    return this.withController(payload, (controller) => controller.play());
  }

  pause(payload: PlaybackIdPayload): Promise<PlaybackRecord> {
    return this.withController(payload, (controller) => controller.pause());
  }

  stop(payload: PlaybackIdPayload): Promise<PlaybackRecord> {
    return this.withController(payload, (controller) => controller.stop());
  }

  restart(payload: PlaybackIdPayload): Promise<PlaybackRecord> {
    return this.withController(payload, (controller) => controller.restart());
  }

  seek(payload: PlaybackSeekRequest): Promise<PlaybackRecord> {
    return this.withController(payload, (controller) => controller.seek(payload.time));
  }

  setLoop(payload: PlaybackLoopRequest): Promise<PlaybackRecord> {
    return this.withController(payload, (controller) => controller.setLoop(payload.enabled));
  }

  setPlaybackRate(payload: PlaybackRateRequest): Promise<PlaybackRecord> {
    return this.withController(payload, (controller) => controller.setPlaybackRate(payload.rate));
  }

  dispose(payload: PlaybackIdPayload): Promise<PlaybackRecord | null> {
    return this.serializeLifecycle(async () => {
      if (this.controller === null) {
        const record = this.lastRecord;
        if (record === null || record.playbackId !== payload.playbackId) {
          throw new PlaybackEngineError("PLAYBACK_NOT_FOUND", undefined, { playbackId: payload.playbackId });
        }
        this.lastRecord = null;
        this.emit("playback.disposed", record);
        return null;
      }
      const controller = this.requireController(payload.playbackId);
      const finalRecord = controller.dispose();
      this.controller = null;
      this.lastRecord = null;
      this.emit("playback.disposed", finalRecord);
      return null;
    });
  }

  disposeForMedia(mediaId: string): Promise<void> {
    return this.serializeLifecycle(async () => {
      if (this.controller?.mediaId === mediaId) {
        const finalRecord = this.controller.dispose();
        this.controller = null;
        this.lastRecord = null;
        this.emit("playback.disposed", finalRecord);
        return;
      }
      if (this.controller === null && this.lastRecord?.mediaId === mediaId) {
        const record = this.lastRecord;
        this.lastRecord = null;
        this.emit("playback.disposed", record);
      }
    });
  }

  disposeAll(): Promise<void> {
    return this.serializeLifecycle(async () => {
      if (this.controller !== null) {
        const finalRecord = this.controller.dispose();
        this.controller = null;
        this.lastRecord = null;
        this.emit("playback.disposed", finalRecord);
        return;
      }
      if (this.lastRecord !== null) {
        const record = this.lastRecord;
        this.lastRecord = null;
        this.emit("playback.disposed", record);
      }
    });
  }

  private withController<T extends PlaybackRecord>(
    payload: PlaybackIdPayload,
    operation: (controller: PlaybackControllerPort) => T | Promise<T>,
  ): Promise<T> {
    return this.serializeLifecycle(async () => operation(this.requireController(payload.playbackId)));
  }

  private requireController(playbackId: string): PlaybackControllerPort {
    if (this.controller === null) {
      throw new PlaybackEngineError(this.lastRecord === null ? "PLAYBACK_NOT_FOUND" : "PLAYBACK_INVALID_STATE", undefined, { playbackId });
    }
    if (this.controller.playbackId !== playbackId) {
      throw new PlaybackEngineError("PLAYBACK_NOT_FOUND", undefined, { playbackId });
    }
    return this.controller;
  }

  private handleControllerEvent(
    controller: PlaybackControllerPort | null,
    type: PlaybackEventType,
    record: PlaybackRecord,
  ): void {
    if (controller !== null && this.controller !== controller) return;
    this.lastRecord = record;
    this.emit(type, record);
  }

  private emit(type: PlaybackEventType, record: PlaybackRecord): void {
    if (this.publishEvent === undefined) return;
    try {
      this.publishEvent(createPlaybackEvent(type, cloneRecord(record)!));
    } catch (error) {
      logger.warn("A playback event could not be published.", {
        type,
        reason: error instanceof Error ? error.message : "Unknown event publication failure.",
      });
    }
  }

  private allocatePlaybackId(): string {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const id = this.createId();
      if (!/^playback_[A-Za-z0-9-]{8,100}$/.test(id) || this.allocatedIds.has(id)) continue;
      this.allocatedIds.add(id);
      return id;
    }
    throw new PlaybackEngineError("PLAYBACK_LOAD_FAILED", "A unique playback ID could not be allocated.");
  }

  private serializeLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.lifecycleQueue.then(operation, operation);
    this.lifecycleQueue = task.then(() => undefined, () => undefined);
    return task;
  }
}
