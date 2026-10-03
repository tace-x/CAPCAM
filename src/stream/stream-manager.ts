import { createEvent, type EventEnvelope } from "../messaging/events";
import { createLogger } from "../shared/logger";
import type { StreamStatus } from "../shared/types";
import { generateStreamId } from "./stream-ids";
import { StreamEngineError, toStreamEngineError, type StreamErrorInfo } from "./stream-errors";
import { transitionStreamState } from "./stream-state";
import type {
  StreamCreateRequest,
  StreamIdPayload,
  StreamInfo,
  StreamPipelineFactory,
  StreamPipelinePort,
  StreamStateSnapshot,
  StreamSwitchSourceRequest,
  StreamTrackInfo,
  TrackInfo,
} from "./stream-types";
import { validateRenderConfig } from "./stream-types";

const logger = createLogger("Stream");
type EventPublisher = (event: EventEnvelope) => void;

export interface StreamManagerOptions {
  createStreamId?: () => string;
  publishEvent?: EventPublisher;
}

function cloneTrackInfo(track: TrackInfo | null): TrackInfo | null {
  return track === null ? null : { ...track, settings: { ...track.settings } };
}

function cloneError(error: StreamErrorInfo | null): StreamErrorInfo | null {
  return error === null
    ? null
    : { ...error, ...(error.details === undefined ? {} : { details: { ...error.details } }) };
}

export class StreamManager {
  private snapshot: StreamStateSnapshot = {
    status: "IDLE",
    changedAt: Date.now(),
    errorMessage: null,
  };
  private streamId: string | null = null;
  private sourceMediaId: string | null = null;
  private config: StreamInfo["config"] = null;
  private errorInfo: StreamErrorInfo | null = null;
  private lastTrackInfo: TrackInfo | null = null;
  private pipeline: StreamPipelinePort | null = null;
  private lifecycleQueue: Promise<void> = Promise.resolve();
  private disposed = false;
  private readonly allocatedIds = new Set<string>();
  private readonly createId: () => string;
  private readonly publishEvent?: EventPublisher;

  constructor(
    private readonly pipelineFactory: StreamPipelineFactory,
    options: StreamManagerOptions = {},
  ) {
    this.createId = options.createStreamId ?? generateStreamId;
    if (options.publishEvent !== undefined) this.publishEvent = options.publishEvent;
  }

  getStatus(): StreamStateSnapshot {
    return { ...this.snapshot };
  }

  getState(): StreamInfo {
    const track = this.readTrackInfo();
    return {
      streamId: this.streamId,
      sourceMediaId: this.pipeline?.sourceMediaId ?? this.sourceMediaId,
      state: this.snapshot.status,
      config: this.config === null ? null : { ...this.config },
      track: cloneTrackInfo(track),
      error: cloneError(this.errorInfo),
      disposed: this.disposed,
      changedAt: this.snapshot.changedAt,
    };
  }

  getActiveCount(): number {
    return this.pipeline === null ? 0 : 1;
  }

  isRendererActive(): boolean {
    return this.pipeline?.isRendering?.() ?? (this.snapshot.status === "ACTIVE");
  }

  create(request: StreamCreateRequest): Promise<StreamInfo> {
    return this.serializeLifecycle(() => this.createInternal(request));
  }

  private async createInternal(request: StreamCreateRequest): Promise<StreamInfo> {
    if (this.pipeline !== null) throw new StreamEngineError("STREAM_ALREADY_ACTIVE");
    const config = validateRenderConfig(request.config);
    if (this.snapshot.status === "INITIALIZING" || this.snapshot.status === "STOPPING") {
      throw new StreamEngineError("STREAM_ALREADY_ACTIVE");
    }

    this.streamId = this.allocateStreamId();
    this.sourceMediaId = request.mediaId;
    this.config = config;
    this.disposed = false;
    this.errorInfo = null;
    this.lastTrackInfo = null;
    this.setStatus("INITIALIZING");
    const allocatedId = this.streamId;

    try {
      const pipeline = await this.pipelineFactory.create(request.mediaId, config, (error) => {
        this.handlePipelineError(allocatedId, error);
      });
      this.pipeline = pipeline;
      this.sourceMediaId = pipeline.sourceMediaId;
      this.lastTrackInfo = pipeline.getTrackInfo();
      this.setStatus("READY");
      return this.getState();
    } catch (error) {
      const failedPipeline = this.pipeline;
      if (failedPipeline !== null) {
        this.lastTrackInfo = this.trackInfoAfterStop(failedPipeline);
        try {
          await failedPipeline.dispose();
        } catch {
          // Pipeline disposal attempts all resource releases even if one browser API reports an error.
        }
        this.pipeline = null;
      }
      this.disposed = true;
      const failure = toStreamEngineError(error, "STREAM_INITIALIZATION_FAILED");
      this.errorInfo = failure.toInfo();
      this.setStatus("ERROR", failure.message);
      throw failure;
    }
  }

  start(payload: StreamIdPayload): Promise<StreamInfo> {
    return this.serializeLifecycle(() => this.startInternal(payload));
  }

  private async startInternal(payload: StreamIdPayload): Promise<StreamInfo> {
    const pipeline = this.requirePipeline(payload.streamId);
    if (this.snapshot.status === "ACTIVE") throw new StreamEngineError("STREAM_ALREADY_ACTIVE");
    try {
      if (this.snapshot.status === "READY") {
        await pipeline.start();
        this.setStatus("ACTIVE");
      } else if (this.snapshot.status === "STOPPED" || this.snapshot.status === "ERROR") {
        this.setStatus("INITIALIZING");
        await pipeline.restart();
        this.lastTrackInfo = pipeline.getTrackInfo();
        this.errorInfo = null;
        this.setStatus("READY");
        this.setStatus("ACTIVE");
      } else {
        throw new StreamEngineError("STREAM_NOT_READY", undefined, { state: this.snapshot.status });
      }
      this.errorInfo = null;
      this.lastTrackInfo = pipeline.getTrackInfo();
      return this.getState();
    } catch (error) {
      const failure = await this.failCurrentStream(error, "STREAM_RENDER_FAILED");
      throw failure;
    }
  }

  stop(payload: StreamIdPayload): Promise<StreamInfo> {
    return this.serializeLifecycle(() => this.stopInternal(payload));
  }

  private async stopInternal(payload: StreamIdPayload): Promise<StreamInfo> {
    const pipeline = this.requirePipeline(payload.streamId);
    if (this.snapshot.status === "STOPPED") return this.getState();
    if (!["ACTIVE", "READY", "ERROR"].includes(this.snapshot.status)) {
      throw new StreamEngineError("STREAM_NOT_READY", undefined, { state: this.snapshot.status });
    }

    this.setStatus("STOPPING");
    try {
      await pipeline.stop();
      this.lastTrackInfo = this.trackInfoAfterStop(pipeline);
      this.errorInfo = null;
      this.setStatus("STOPPED");
      return this.getState();
    } catch (error) {
      const failure = await this.failCurrentStream(error, "STREAM_RENDER_FAILED");
      throw failure;
    }
  }

  restart(payload: StreamIdPayload): Promise<StreamInfo> {
    return this.serializeLifecycle(() => this.restartInternal(payload));
  }

  private async restartInternal(payload: StreamIdPayload): Promise<StreamInfo> {
    const pipeline = this.requirePipeline(payload.streamId);
    if (!["ACTIVE", "READY", "STOPPED", "ERROR"].includes(this.snapshot.status)) {
      throw new StreamEngineError("STREAM_NOT_READY", undefined, { state: this.snapshot.status });
    }

    try {
      if (this.snapshot.status !== "STOPPED") {
        this.setStatus("STOPPING");
        await pipeline.stop();
        this.lastTrackInfo = this.trackInfoAfterStop(pipeline);
        this.setStatus("STOPPED");
      }
      this.setStatus("INITIALIZING");
      await pipeline.restart();
      this.lastTrackInfo = pipeline.getTrackInfo();
      this.setStatus("READY");
      this.errorInfo = null;
      this.setStatus("ACTIVE");
      return this.getState();
    } catch (error) {
      const failure = await this.failCurrentStream(error, "STREAM_RENDER_FAILED");
      throw failure;
    }
  }

  switchSource(request: StreamSwitchSourceRequest): Promise<StreamInfo> {
    return this.serializeLifecycle(() => this.switchSourceInternal(request));
  }

  private async switchSourceInternal(request: StreamSwitchSourceRequest): Promise<StreamInfo> {
    const pipeline = this.requirePipeline(request.streamId);
    if (!["READY", "ACTIVE", "STOPPED", "ERROR"].includes(this.snapshot.status)) {
      throw new StreamEngineError("STREAM_NOT_READY", undefined, { state: this.snapshot.status });
    }
    try {
      await pipeline.switchSource(request.mediaId);
      this.sourceMediaId = pipeline.sourceMediaId;
      this.lastTrackInfo = pipeline.getTrackInfo();
      if (this.snapshot.status !== "ERROR") this.errorInfo = null;
      this.publishCurrentState();
      return this.getState();
    } catch (error) {
      throw toStreamEngineError(error, "STREAM_SOURCE_UNAVAILABLE");
    }
  }

  getTrackInfo(payload: StreamIdPayload): StreamTrackInfo {
    this.assertStreamId(payload.streamId);
    return { streamId: payload.streamId, track: cloneTrackInfo(this.readTrackInfo()) };
  }

  getStream(): MediaStream {
    if (this.pipeline === null) {
      throw new StreamEngineError(this.disposed ? "STREAM_DISPOSED" : "STREAM_NOT_READY");
    }
    return this.pipeline.getStream();
  }

  getTrack(): MediaStreamTrack {
    if (this.pipeline === null) {
      throw new StreamEngineError(this.disposed ? "STREAM_DISPOSED" : "STREAM_NOT_READY");
    }
    return this.pipeline.getTrack();
  }

  getCanvas(): HTMLCanvasElement {
    if (this.pipeline === null) {
      throw new StreamEngineError(this.disposed ? "STREAM_DISPOSED" : "STREAM_NOT_READY");
    }
    return this.pipeline.getCanvas();
  }

  dispose(payload?: StreamIdPayload): Promise<StreamInfo> {
    return this.serializeLifecycle(() => this.disposeInternal(payload));
  }

  private async disposeInternal(payload?: StreamIdPayload): Promise<StreamInfo> {
    if (payload?.streamId !== undefined) this.assertStreamId(payload.streamId);
    const pipeline = this.pipeline;
    if (pipeline === null) {
      if (this.streamId !== null) {
        this.disposed = true;
        this.publishCurrentState();
      }
      return this.getState();
    }

    if (this.snapshot.status !== "STOPPED" && this.snapshot.status !== "STOPPING") this.setStatus("STOPPING");
    let cleanupFailure: unknown;
    try {
      this.lastTrackInfo = this.trackInfoAfterStop(pipeline);
      await pipeline.dispose();
    } catch (error) {
      cleanupFailure = error;
    } finally {
      this.pipeline = null;
      this.disposed = true;
      this.sourceMediaId = pipeline.sourceMediaId;
    }

    if (cleanupFailure !== undefined) {
      const failure = toStreamEngineError(cleanupFailure, "STREAM_RENDER_FAILED");
      this.errorInfo = failure.toInfo();
      if (this.snapshot.status === "STOPPING") this.setStatus("ERROR", failure.message);
      throw failure;
    }
    this.errorInfo = null;
    if (this.snapshot.status === "STOPPING") this.setStatus("STOPPED");
    else this.publishCurrentState();
    return this.getState();
  }

  disposeForMedia(mediaId: string): Promise<void> {
    return this.serializeLifecycle(async () => {
      if (this.pipeline?.sourceMediaId === mediaId && this.streamId !== null) {
        await this.disposeInternal({ streamId: this.streamId });
      }
    });
  }

  disposeAll(): Promise<void> {
    return this.serializeLifecycle(async () => {
      if (this.pipeline !== null && this.streamId !== null) {
        await this.disposeInternal({ streamId: this.streamId });
      }
    });
  }

  private serializeLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.lifecycleQueue.then(operation, operation);
    this.lifecycleQueue = task.then(() => undefined, () => undefined);
    return task;
  }

  private readTrackInfo(): TrackInfo | null {
    if (this.pipeline === null) return this.lastTrackInfo;
    try {
      this.lastTrackInfo = this.pipeline.getTrackInfo();
    } catch {
      // Preserve the last safe inspection snapshot if a browser track ended during cleanup.
    }
    return cloneTrackInfo(this.lastTrackInfo);
  }

  private trackInfoAfterStop(pipeline: StreamPipelinePort): TrackInfo | null {
    try {
      const track = pipeline.getTrackInfo();
      return { ...track, readyState: "ended", settings: { ...track.settings } };
    } catch {
      return cloneTrackInfo(this.lastTrackInfo);
    }
  }

  private requirePipeline(streamId: string): StreamPipelinePort {
    this.assertStreamId(streamId);
    if (this.disposed) throw new StreamEngineError("STREAM_DISPOSED");
    if (this.pipeline === null) throw new StreamEngineError("STREAM_NOT_READY");
    return this.pipeline;
  }

  private assertStreamId(streamId: string): void {
    if (this.streamId === null) throw new StreamEngineError("STREAM_NOT_FOUND");
    if (this.streamId !== streamId) throw new StreamEngineError("STREAM_NOT_FOUND", undefined, { streamId });
  }

  private allocateStreamId(): string {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const id = this.createId();
      if (!/^stream_[A-Za-z0-9-]{8,100}$/.test(id) || this.allocatedIds.has(id)) continue;
      this.allocatedIds.add(id);
      return id;
    }
    throw new StreamEngineError("STREAM_INITIALIZATION_FAILED", "A unique stream ID could not be allocated.");
  }

  private setStatus(status: StreamStatus, errorMessage: string | null = null): void {
    const nextStatus = transitionStreamState(this.snapshot.status, status);
    this.snapshot = {
      status: nextStatus,
      changedAt: Date.now(),
      errorMessage: nextStatus === "ERROR" ? errorMessage : null,
    };
    logger.debug("Stream lifecycle state updated.", { status: nextStatus });
    this.publishCurrentState();
  }

  private publishCurrentState(): void {
    if (this.publishEvent === undefined) return;
    try {
      this.publishEvent(createEvent("stream.stateChanged", this.getState()));
    } catch (error) {
      logger.warn("A stream lifecycle event could not be published.", {
        reason: error instanceof Error ? error.message : "Unknown event publication failure.",
      });
    }
  }

  private async failCurrentStream(error: unknown, fallback: "STREAM_INITIALIZATION_FAILED" | "STREAM_RENDER_FAILED"): Promise<StreamEngineError> {
    const failure = toStreamEngineError(error, fallback);
    try {
      await this.pipeline?.stop();
      if (this.pipeline !== null) this.lastTrackInfo = this.trackInfoAfterStop(this.pipeline);
    } catch {
      // Preserve the original pipeline error; stop() has already attempted track cleanup.
    }
    this.errorInfo = failure.toInfo();
    if (this.snapshot.status !== "ERROR") {
      this.setStatus("ERROR", failure.message);
    } else {
      this.publishCurrentState();
    }
    return failure;
  }

  private handlePipelineError(streamId: string, error: unknown): void {
    if (streamId !== this.streamId || this.disposed || this.snapshot.status !== "ACTIVE") return;
    const failure = toStreamEngineError(error, "STREAM_RENDER_FAILED");
    this.errorInfo = failure.toInfo();
    this.setStatus("ERROR", failure.message);
    const pipeline = this.pipeline;
    if (pipeline === null) return;
    void pipeline.stop().then(() => {
      if (streamId !== this.streamId) return;
      this.lastTrackInfo = this.trackInfoAfterStop(pipeline);
      this.publishCurrentState();
    }).catch((stopError: unknown) => {
      logger.warn("A failed render loop could not stop cleanly.", {
        code: toStreamEngineError(stopError, "STREAM_RENDER_FAILED").streamCode,
      });
    });
  }
}
