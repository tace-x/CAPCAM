import { CapCamError } from "../shared/errors";
import { createLogger } from "../shared/logger";
import { MediaEngine } from "../media/media-engine";
import type { MediaClearResult, MediaIdPayload, MediaRecord, MediaRegisterPayload } from "../media/media-types";
import { CanvasStreamPipelineFactory } from "../stream/canvas-stream-pipeline";
import { StreamManager } from "../stream/stream-manager";
import type { StreamCreateRequest, StreamIdPayload, StreamInfo, StreamSwitchSourceRequest, StreamTrackInfo } from "../stream/stream-types";
import { PlaybackEngine } from "../playback/playback-engine";
import type { PlaybackIdPayload, PlaybackLoadRequest, PlaybackLoopRequest, PlaybackRateRequest, PlaybackRecord, PlaybackSeekRequest } from "../playback/playback-types";

const logger = createLogger("Media");

export type MediaRuntimeStatus = "STARTING" | "READY" | "STOPPED" | "ERROR";

export interface MediaRuntimeInfo {
  status: MediaRuntimeStatus;
  initializedAt: number | null;
}

/** Offscreen-owned facade for local ingestion and canvas streams. Resources never leave this runtime. */
export class MediaRuntime {
  private info: MediaRuntimeInfo = { status: "STARTING", initializedAt: null };
  // Keep multi-engine source changes and media removal/clear atomic at the facade boundary.
  private lifecycleQueue: Promise<void> = Promise.resolve();
  readonly mediaEngine: MediaEngine;
  readonly streams: StreamManager;
  readonly playback: PlaybackEngine;
  readonly canvasPipelineFactory: CanvasStreamPipelineFactory;

  constructor(mediaEngine: MediaEngine, streams?: StreamManager, playback?: PlaybackEngine) {
    this.mediaEngine = mediaEngine;
    this.canvasPipelineFactory = new CanvasStreamPipelineFactory(mediaEngine);
    this.streams = streams ?? new StreamManager(this.canvasPipelineFactory);
    this.playback = playback ?? new PlaybackEngine(mediaEngine);
  }

  async initialize(): Promise<MediaRuntimeInfo> {
    if (this.info.status === "READY") return this.getStatus();
    try {
      this.info = { status: "STARTING", initializedAt: null };
      await this.mediaEngine.initialize();
      this.info = { status: "READY", initializedAt: Date.now() };
      return this.getStatus();
    } catch (error) {
      this.info = { status: "ERROR", initializedAt: null };
      throw new CapCamError("CAPCAM_RUNTIME_ERROR", "Media runtime initialization failed.", {
        reason: error instanceof Error ? error.message : "Unknown media runtime initialization error.",
      });
    }
  }

  getStatus(): MediaRuntimeInfo {
    return { ...this.info };
  }

  register(payload: MediaRegisterPayload): Promise<MediaRecord> {
    return this.mediaEngine.register(payload.transferId);
  }

  get(payload: MediaIdPayload): MediaRecord {
    return this.mediaEngine.get(payload.mediaId);
  }

  list(): MediaRecord[] {
    return this.mediaEngine.list();
  }

  remove(payload: MediaIdPayload): Promise<MediaRecord> {
    return this.serializeLifecycle(() => this.removeInternal(payload));
  }

  private async removeInternal(payload: MediaIdPayload): Promise<MediaRecord> {
    try {
      await this.playback.disposeForMedia(payload.mediaId);
    } catch (error) {
      logger.warn("Playback disposal reported an error before media removal; media resource release will continue.", {
        reason: error instanceof Error ? error.message : "Unknown playback disposal failure.",
      });
    }
    try {
      await this.streams.disposeForMedia(payload.mediaId);
    } catch (error) {
      logger.warn("Stream disposal reported an error before media removal; media resource release will continue.", {
        reason: error instanceof Error ? error.message : "Unknown stream disposal failure.",
      });
    }
    return this.mediaEngine.remove(payload.mediaId);
  }

  clear(): Promise<MediaClearResult> {
    return this.serializeLifecycle(() => this.clearInternal());
  }

  private async clearInternal(): Promise<MediaClearResult> {
    try {
      await this.playback.disposeAll();
    } catch (error) {
      logger.warn("Playback disposal reported an error before media clear; media resource release will continue.", {
        reason: error instanceof Error ? error.message : "Unknown playback disposal failure.",
      });
    }
    try {
      await this.streams.disposeAll();
    } catch (error) {
      logger.warn("Stream disposal reported an error before media clear; media resource release will continue.", {
        reason: error instanceof Error ? error.message : "Unknown stream disposal failure.",
      });
    }
    return this.mediaEngine.clear();
  }

  inspect(payload: MediaIdPayload): MediaRecord {
    return this.mediaEngine.inspect(payload.mediaId);
  }

  createStream(payload: StreamCreateRequest): Promise<StreamInfo> {
    return this.serializeLifecycle(() => this.createStreamInternal(payload));
  }

  private async createStreamInternal(payload: StreamCreateRequest): Promise<StreamInfo> {
    const current = this.streams.getState();
    if (current.streamId !== null && !current.disposed) return this.streams.create(payload);
    await this.loadPlaybackInternal({ mediaId: payload.mediaId });
    return this.streams.create(payload);
  }

  getStreamState(): StreamInfo {
    return this.streams.getState();
  }

  loadPlayback(request: PlaybackLoadRequest): Promise<PlaybackRecord> {
    return this.serializeLifecycle(() => this.loadPlaybackInternal(request));
  }

  private async loadPlaybackInternal(request: PlaybackLoadRequest): Promise<PlaybackRecord> {
    const record = await this.playback.load(request);
    const stream = this.streams.getState();
    if (stream.streamId !== null && !stream.disposed && stream.sourceMediaId !== request.mediaId) {
      await this.streams.switchSource({ streamId: stream.streamId, mediaId: request.mediaId });
    }
    return record;
  }

  getPlaybackState(): PlaybackRecord | null {
    return this.playback.getState();
  }

  playPlayback(payload: PlaybackIdPayload): Promise<PlaybackRecord> {
    return this.playback.play(payload);
  }

  pausePlayback(payload: PlaybackIdPayload): Promise<PlaybackRecord> {
    return this.playback.pause(payload);
  }

  stopPlayback(payload: PlaybackIdPayload): Promise<PlaybackRecord> {
    return this.playback.stop(payload);
  }

  restartPlayback(payload: PlaybackIdPayload): Promise<PlaybackRecord> {
    return this.playback.restart(payload);
  }

  seekPlayback(payload: PlaybackSeekRequest): Promise<PlaybackRecord> {
    return this.playback.seek(payload);
  }

  setPlaybackLoop(payload: PlaybackLoopRequest): Promise<PlaybackRecord> {
    return this.playback.setLoop(payload);
  }

  setPlaybackRate(payload: PlaybackRateRequest): Promise<PlaybackRecord> {
    return this.playback.setPlaybackRate(payload);
  }

  disposePlayback(payload: PlaybackIdPayload): Promise<PlaybackRecord | null> {
    return this.playback.dispose(payload);
  }

  startStream(payload: StreamIdPayload): Promise<StreamInfo> {
    return this.streams.start(payload);
  }

  stopStream(payload: StreamIdPayload): Promise<StreamInfo> {
    return this.streams.stop(payload);
  }

  restartStream(payload: StreamIdPayload): Promise<StreamInfo> {
    return this.streams.restart(payload);
  }

  switchStreamSource(payload: StreamSwitchSourceRequest): Promise<StreamInfo> {
    return this.serializeLifecycle(() => this.switchStreamSourceInternal(payload));
  }

  private async switchStreamSourceInternal(payload: StreamSwitchSourceRequest): Promise<StreamInfo> {
    const current = this.streams.getState();
    if (current.streamId !== payload.streamId || current.disposed) return this.streams.switchSource(payload);
    await this.loadPlaybackInternal({ mediaId: payload.mediaId });
    return this.streams.getState();
  }

  getStreamTrackInfo(payload: StreamIdPayload): StreamTrackInfo {
    return this.streams.getTrackInfo(payload);
  }

  disposeStream(payload: StreamIdPayload): Promise<StreamInfo> {
    return this.streams.dispose(payload);
  }

  private serializeLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.lifecycleQueue.then(operation, operation);
    this.lifecycleQueue = task.then(() => undefined, () => undefined);
    return task;
  }

  async shutdown(): Promise<MediaRuntimeInfo> {
    if (this.info.status === "STOPPED") return this.getStatus();
    let cleanupFailure: unknown;
    try {
      await this.playback.disposeAll();
    } catch (error) {
      cleanupFailure = error;
    }
    try {
      await this.streams.disposeAll();
    } catch (error) {
      cleanupFailure ??= error;
    }
    try {
      await this.mediaEngine.shutdown();
    } catch (error) {
      cleanupFailure ??= error;
    }

    if (cleanupFailure !== undefined) {
      this.info = { status: "ERROR", initializedAt: null };
      throw new CapCamError("CAPCAM_RUNTIME_ERROR", "Media runtime shutdown failed.", {
        reason: cleanupFailure instanceof Error ? cleanupFailure.message : "Unknown media runtime shutdown error.",
      });
    }
    this.info = { status: "STOPPED", initializedAt: null };
    return this.getStatus();
  }
}
