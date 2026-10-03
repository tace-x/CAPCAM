import { toCapCamError } from "../shared/errors";
import { createInitialCapCamState } from "../shared/state";
import { createLogger } from "../shared/logger";
import type { CapCamState, OffscreenRuntimeInfo } from "../shared/types";
import type { CapCamSettings } from "../storage/settings";
import type { MediaClearResult, MediaIdPayload, MediaRecord, MediaRegisterPayload } from "../media/media-types";
import type { StreamCreateRequest, StreamIdPayload, StreamInfo, StreamSwitchSourceRequest, StreamTrackInfo } from "../stream/stream-types";
import type { PlaybackIdPayload, PlaybackLoadRequest, PlaybackLoopRequest, PlaybackRateRequest, PlaybackRecord, PlaybackSeekRequest } from "../playback/playback-types";
import type { RuntimeDiagnostics, RuntimePingResponse, RuntimeStateSnapshot } from "../shared/runtime-types";
import type { OffscreenService } from "./offscreen-manager";

export interface SettingsService {
  getSettings(): Promise<CapCamSettings>;
  updateSettings(patch: Partial<CapCamSettings>): Promise<CapCamSettings>;
}

const logger = createLogger("Runtime");

export class BackgroundRuntime {
  private state: CapCamState = createInitialCapCamState();
  private initialization: Promise<void> | null = null;

  constructor(
    private readonly offscreen: OffscreenService,
    private readonly settings: SettingsService,
  ) {}

  initialize(): Promise<void> {
    if (this.state.runtime.status === "READY" && this.state.offscreen.status === "READY") {
      return Promise.resolve();
    }
    if (this.initialization !== null) return this.initialization;

    this.initialization = this.initializeRuntime().finally(() => {
      this.initialization = null;
    });
    return this.initialization;
  }

  async getStatus(): Promise<CapCamState> {
    await this.initialize();
    try {
      this.state.settings = await this.settings.getSettings();
      const status = await this.offscreen.getStatus();
      this.applyOffscreenInfo(status);
      if (status.status !== "READY") {
        await this.initialize();
        const recoveredStatus = await this.offscreen.getStatus();
        this.applyOffscreenInfo(recoveredStatus);
      }
      if (this.state.offscreen.status === "READY") {
        try {
          this.state.stream.status = (await this.offscreen.execute("stream.getState")).state;
        } catch (error) {
          logger.warn("Stream status could not be reconciled.", { code: toCapCamError(error).code });
        }
      }
    } catch (error) {
      const failure = toCapCamError(error);
      this.state.runtime.status = "ERROR";
      if (this.state.offscreen.status !== "READY") this.state.offscreen.status = "ERROR";
      logger.error("Runtime status reconciliation failed.", { code: failure.code });
    }
    return this.copyState();
  }

  async getOffscreenStatus(): Promise<OffscreenRuntimeInfo> {
    const status = await this.offscreen.getStatus();
    this.applyOffscreenInfo(status);
    return { ...status };
  }

  async initializeOffscreen(): Promise<OffscreenRuntimeInfo> {
    await this.initialize();
    const status = await this.offscreen.initialize();
    this.applyOffscreenInfo(status);
    if (status.status === "READY") this.state.runtime.status = "READY";
    return { ...status };
  }

  async shutdown(): Promise<OffscreenRuntimeInfo> {
    const status = await this.offscreen.shutdown();
    this.applyOffscreenInfo(status);
    return { ...status };
  }

  async initializeMediaRuntime(): Promise<RuntimeStateSnapshot> {
    await this.initialize();
    const snapshot = await this.offscreen.execute("runtime.initialize");
    this.applyRuntimeSnapshot(snapshot);
    return snapshot;
  }

  async shutdownMediaRuntime(): Promise<RuntimeStateSnapshot> {
    const snapshot = await this.offscreen.execute("runtime.shutdown");
    this.applyRuntimeSnapshot(snapshot);
    return snapshot;
  }

  async resetMediaRuntime(): Promise<RuntimeStateSnapshot> {
    const snapshot = await this.offscreen.execute("runtime.reset");
    this.applyRuntimeSnapshot(snapshot);
    return snapshot;
  }

  getRuntimeState(): Promise<RuntimeStateSnapshot> {
    return this.offscreen.execute("runtime.getState");
  }

  getRuntimeDiagnostics(): Promise<RuntimeDiagnostics> {
    return this.offscreen.execute("runtime.getDiagnostics");
  }

  pingRuntime(): Promise<RuntimePingResponse> {
    return this.offscreen.execute("runtime.ping");
  }

  getRuntimeSessionId(): string | undefined {
    return this.offscreen.getKnownRuntimeSessionId?.() ?? undefined;
  }

  registerMedia(payload: MediaRegisterPayload): Promise<MediaRecord> {
    return this.offscreen.execute("media.register", payload);
  }

  getMedia(payload: MediaIdPayload): Promise<MediaRecord> {
    return this.offscreen.execute("media.get", payload);
  }

  listMedia(): Promise<MediaRecord[]> {
    return this.offscreen.execute("media.list");
  }

  removeMedia(payload: MediaIdPayload): Promise<MediaRecord> {
    return this.offscreen.execute("media.remove", payload);
  }

  clearMedia(): Promise<MediaClearResult> {
    return this.offscreen.execute("media.clear");
  }

  inspectMedia(payload: MediaIdPayload): Promise<MediaRecord> {
    return this.offscreen.execute("media.inspect", payload);
  }

  async createStream(payload: StreamCreateRequest): Promise<StreamInfo> {
    return this.applyStreamInfo(await this.offscreen.execute("stream.create", payload));
  }

  async getStreamState(): Promise<StreamInfo> {
    return this.applyStreamInfo(await this.offscreen.execute("stream.getState"));
  }

  async startStream(payload: StreamIdPayload): Promise<StreamInfo> {
    return this.applyStreamInfo(await this.offscreen.execute("stream.start", payload));
  }

  async stopStream(payload: StreamIdPayload): Promise<StreamInfo> {
    return this.applyStreamInfo(await this.offscreen.execute("stream.stop", payload));
  }

  async restartStream(payload: StreamIdPayload): Promise<StreamInfo> {
    return this.applyStreamInfo(await this.offscreen.execute("stream.restart", payload));
  }

  async switchStreamSource(payload: StreamSwitchSourceRequest): Promise<StreamInfo> {
    return this.applyStreamInfo(await this.offscreen.execute("stream.switchSource", payload));
  }

  getStreamTrackInfo(payload: StreamIdPayload): Promise<StreamTrackInfo> {
    return this.offscreen.execute("stream.getTrackInfo", payload);
  }

  async disposeStream(payload: StreamIdPayload): Promise<StreamInfo> {
    return this.applyStreamInfo(await this.offscreen.execute("stream.dispose", payload));
  }

  loadPlayback(payload: PlaybackLoadRequest): Promise<PlaybackRecord> {
    return this.offscreen.execute("playback.load", payload);
  }

  playPlayback(payload: PlaybackIdPayload): Promise<PlaybackRecord> {
    return this.offscreen.execute("playback.play", payload);
  }

  pausePlayback(payload: PlaybackIdPayload): Promise<PlaybackRecord> {
    return this.offscreen.execute("playback.pause", payload);
  }

  stopPlayback(payload: PlaybackIdPayload): Promise<PlaybackRecord> {
    return this.offscreen.execute("playback.stop", payload);
  }

  restartPlayback(payload: PlaybackIdPayload): Promise<PlaybackRecord> {
    return this.offscreen.execute("playback.restart", payload);
  }

  seekPlayback(payload: PlaybackSeekRequest): Promise<PlaybackRecord> {
    return this.offscreen.execute("playback.seek", payload);
  }

  setPlaybackLoop(payload: PlaybackLoopRequest): Promise<PlaybackRecord> {
    return this.offscreen.execute("playback.setLoop", payload);
  }

  setPlaybackRate(payload: PlaybackRateRequest): Promise<PlaybackRecord> {
    return this.offscreen.execute("playback.setRate", payload);
  }

  getPlaybackState(): Promise<PlaybackRecord | null> {
    return this.offscreen.execute("playback.getState");
  }

  disposePlayback(payload: PlaybackIdPayload): Promise<PlaybackRecord | null> {
    return this.offscreen.execute("playback.dispose", payload);
  }

  async getSettings(): Promise<CapCamSettings> {
    const settings = await this.settings.getSettings();
    this.state.settings = { ...settings };
    return { ...settings };
  }

  async updateSettings(patch: Partial<CapCamSettings>): Promise<CapCamSettings> {
    const settings = await this.settings.updateSettings(patch);
    this.state.settings = { ...settings };
    return { ...settings };
  }

  private async initializeRuntime(): Promise<void> {
    this.state.runtime.status = "STARTING";
    this.state.offscreen.status = "STARTING";
    try {
      this.state.settings = await this.settings.getSettings();
      const status = await this.offscreen.initialize();
      this.applyOffscreenInfo(status);
      this.state.runtime.status = status.status === "READY" ? "READY" : "ERROR";
      if (status.status === "READY") logger.info("Service worker runtime ready.");
    } catch (error) {
      const failure = toCapCamError(error);
      this.state.runtime.status = "ERROR";
      this.state.offscreen.status = "ERROR";
      logger.error("Service worker runtime initialization failed.", { code: failure.code });
    }
  }

  private applyRuntimeSnapshot(snapshot: RuntimeStateSnapshot): void {
    const status: OffscreenRuntimeInfo["status"] =
      snapshot.state === "created" || snapshot.state === "stopped" ? "STOPPED"
        : snapshot.state === "initializing" || snapshot.state === "stopping" || snapshot.state === "resetting" ? "STARTING"
        : snapshot.state === "error" ? "ERROR"
        : "READY";
    this.state.offscreen.status = status;
    if (snapshot.state === "stopped" || snapshot.state === "resetting") this.state.stream.status = "IDLE";
    if (status === "READY") this.state.runtime.status = "READY";
    if (status === "ERROR") this.state.runtime.status = "ERROR";
  }

  private applyStreamInfo(info: StreamInfo): StreamInfo {
    this.state.stream.status = info.state;
    return info;
  }

  private applyOffscreenInfo(info: OffscreenRuntimeInfo): void {
    this.state.offscreen.status = info.status;
    if (info.status === "STOPPED") this.state.stream.status = "STOPPED";
    if (info.status === "ERROR" && this.state.runtime.status === "READY") {
      this.state.runtime.status = "ERROR";
    }
  }

  private copyState(): CapCamState {
    return {
      runtime: { ...this.state.runtime },
      offscreen: { ...this.state.offscreen },
      media: { ...this.state.media },
      stream: { ...this.state.stream },
      settings: { ...this.state.settings },
    };
  }
}
