import { PlaybackEngineError, toPlaybackEngineError } from "./playback-errors";
import type { PlaybackEventType } from "./playback-events";
import { canTransitionPlaybackState, transitionPlaybackState } from "./playback-state";
import { DEFAULT_PLAYBACK_RATE, isPlaybackRate, type PlaybackControllerPort, type PlaybackRecord } from "./playback-types";
import type { RenderableMediaSource } from "../canvas/render-types";

export interface PlaybackControllerDependencies {
  now?: () => number;
  setTimeout?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimeout?: (handle: ReturnType<typeof setTimeout>) => void;
  metadataTimeoutMs?: number;
}

export type PlaybackControllerEventPublisher = (type: PlaybackEventType, record: PlaybackRecord) => void;

const DEFAULT_METADATA_TIMEOUT_MS = 30_000;
const TIMEUPDATE_THROTTLE_MS = 500;

function cloneRecord(record: PlaybackRecord): PlaybackRecord {
  return {
    ...record,
    error: record.error === null
      ? null
      : { ...record.error, ...(record.error.details === undefined ? {} : { details: { ...record.error.details } }) },
  };
}

function finiteDuration(value: number): number | null {
  return Number.isFinite(value) && value >= 0 ? value : null;
}

export class PlaybackController implements PlaybackControllerPort {
  private source: RenderableMediaSource | null;
  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (handle: ReturnType<typeof setTimeout>) => void;
  private readonly metadataTimeoutMs: number;
  private readonly videoListeners: Array<{ type: string; listener: EventListener }> = [];
  private record: PlaybackRecord;
  private disposed = false;
  private pendingSeek: number | null = null;
  private loadSeekRequested = false;
  private lastTimeUpdateAt = 0;
  private imageTimer: ReturnType<typeof setTimeout> | null = null;
  private imageTimerStartedAt: number | null = null;
  private imageRemainingMs: number | null;
  private metadataWaitCleanup: (() => void) | null = null;
  private lastFailure: PlaybackEngineError | null = null;

  constructor(
    record: PlaybackRecord,
    source: RenderableMediaSource,
    private readonly publishEvent: PlaybackControllerEventPublisher,
    dependencies: PlaybackControllerDependencies = {},
  ) {
    this.record = cloneRecord(record);
    this.source = source;
    this.now = dependencies.now ?? Date.now;
    this.setTimer = dependencies.setTimeout ?? ((callback, delayMs) => globalThis.setTimeout(callback, delayMs));
    this.clearTimer = dependencies.clearTimeout ?? ((handle) => globalThis.clearTimeout(handle));
    this.metadataTimeoutMs = dependencies.metadataTimeoutMs ?? DEFAULT_METADATA_TIMEOUT_MS;
    this.imageRemainingMs = source.kind === "image" && record.duration !== null ? record.duration * 1000 : null;
  }

  get playbackId(): string {
    return this.record.playbackId;
  }

  get mediaId(): string {
    return this.record.mediaId;
  }

  async load(): Promise<PlaybackRecord> {
    this.assertActive();
    if (this.record.state !== "LOADING") throw new PlaybackEngineError("PLAYBACK_INVALID_STATE", "A playback controller can only load once.", { state: this.record.state });
    try {
      const source = this.requireSource();
      if (source.kind === "image") {
        if (!source.element.complete || source.element.naturalWidth <= 0 || source.element.naturalHeight <= 0) {
          throw new PlaybackEngineError("PLAYBACK_LOAD_FAILED", "The decoded image is not ready for presentation.", { mediaId: source.mediaId });
        }
        this.imageRemainingMs = this.record.duration === null ? null : this.record.duration * 1000;
      } else {
        const video = source.element;
        this.attachVideoListeners(video);
        video.loop = false; // ended is handled explicitly so loop events and state stay deterministic.
        video.playbackRate = DEFAULT_PLAYBACK_RATE;
        video.pause();
        if (video.readyState < 1) {
          await this.waitForMetadata(video);
          this.assertActive();
          if (this.lastFailure !== null) throw this.lastFailure;
          if (!this.loadSeekRequested) video.currentTime = 0;
        } else {
          this.syncVideoDuration();
          video.currentTime = 0;
        }
        this.record = { ...this.record, currentTime: this.readVideoTime(), playbackRate: DEFAULT_PLAYBACK_RATE };
      }
      this.transition("READY", "playback.loaded", { currentTime: this.readVideoTime(), startedAt: null, error: null });
      return this.getState();
    } catch (error) {
      throw this.fail(error, "PLAYBACK_LOAD_FAILED");
    }
  }

  async play(): Promise<PlaybackRecord> {
    this.assertLoaded();
    if (this.record.state === "PLAYING") return this.getState();
    if (this.record.state === "ERROR") throw this.recordError();

    const source = this.requireSource();
    if (source.kind === "image") {
      if (this.record.state === "ENDED" || this.imageRemainingMs === 0) {
        this.imageRemainingMs = this.record.duration === null ? null : this.record.duration * 1000;
      }
      this.transition("PLAYING", "playback.play", { currentTime: 0, startedAt: this.now(), error: null });
      this.scheduleImageEnd();
      return this.getState();
    }

    const video = source.element;
    try {
      if (this.record.state === "ENDED" && (this.record.duration === null || this.record.currentTime >= this.record.duration)) {
        video.currentTime = 0;
        this.update({ currentTime: 0 });
      }
      await video.play();
      this.assertActive();
      if (!this.isCurrentlyPlaying()) {
        this.transition("PLAYING", "playback.play", { startedAt: this.now(), error: null });
      }
      return this.getState();
    } catch (error) {
      throw this.fail(error, "PLAYBACK_PLAY_FAILED");
    }
  }

  pause(): PlaybackRecord {
    this.assertLoaded();
    if (this.record.state !== "PLAYING") return this.getState();
    const source = this.requireSource();
    if (source.kind === "image") {
      this.consumeImageTime();
      this.transition("PAUSED", "playback.pause", { startedAt: this.record.startedAt });
      return this.getState();
    }

    try {
      source.element.pause();
      const currentTime = this.readVideoTime();
      if (this.isCurrentlyPlaying()) {
        this.transition("PAUSED", "playback.pause", { currentTime, startedAt: this.record.startedAt });
      } else {
        this.update({ currentTime });
      }
      return this.getState();
    } catch (error) {
      throw this.fail(error, "PLAYBACK_INVALID_STATE");
    }
  }

  stop(): PlaybackRecord {
    this.assertActive();
    if (this.record.state === "IDLE" || this.record.state === "LOADING") {
      throw new PlaybackEngineError("PLAYBACK_INVALID_STATE", undefined, { state: this.record.state });
    }
    const source = this.source;
    this.clearImageTimer(false);
    if (source?.kind === "image") {
      this.imageRemainingMs = this.record.duration === null ? null : this.record.duration * 1000;
    } else if (source?.kind === "video") {
      try {
        source.element.pause();
        if (source.element.readyState >= 1) source.element.currentTime = 0;
        else this.pendingSeek = 0;
      } catch (error) {
        throw this.fail(error, "PLAYBACK_SEEK_FAILED");
      }
    }
    this.transition("STOPPED", "playback.stop", { currentTime: 0, startedAt: null, error: null });
    return this.getState();
  }

  async restart(): Promise<PlaybackRecord> {
    this.assertLoaded();
    const source = this.requireSource();
    if (source.kind === "image") {
      this.clearImageTimer(false);
      this.imageRemainingMs = this.record.duration === null ? null : this.record.duration * 1000;
      if (this.record.state !== "PLAYING") {
        this.transition("PLAYING", "playback.play", { currentTime: 0, startedAt: this.now(), error: null });
      } else {
        this.update({ currentTime: 0, startedAt: this.now() });
      }
      this.scheduleImageEnd();
      return this.getState();
    }

    try {
      if (source.element.readyState >= 1) source.element.currentTime = 0;
      else this.pendingSeek = 0;
      this.update({ currentTime: 0 });
      if (this.record.state !== "PLAYING") {
        // A restart is an explicit seek-to-zero followed by play.
        if (this.record.state === "READY" || this.record.state === "PAUSED" || this.record.state === "STOPPED" || this.record.state === "ENDED") {
          await this.play();
        } else {
          throw new PlaybackEngineError("PLAYBACK_INVALID_STATE", undefined, { state: this.record.state });
        }
      } else {
        await source.element.play();
      }
      return this.getState();
    } catch (error) {
      throw this.fail(error, "PLAYBACK_PLAY_FAILED");
    }
  }

  seek(time: number): PlaybackRecord {
    this.assertLoaded(true);
    if (!Number.isFinite(time)) throw new PlaybackEngineError("PLAYBACK_INVALID_TIME", undefined, { time });
    const source = this.requireSource();
    if (source.kind === "image") {
      // Images have no timeline; seek is deliberately a no-op and currentTime remains 0.
      this.update({ currentTime: 0 }, "playback.seek");
      return this.getState();
    }

    const duration = finiteDuration(source.element.duration);
    const target = Math.max(0, duration === null ? time : Math.min(time, duration));
    try {
      if (source.element.readyState < 1) {
        this.pendingSeek = target;
        if (this.record.state === "LOADING") this.loadSeekRequested = true;
      } else source.element.currentTime = target;
      this.update({ currentTime: target }, "playback.seek");
      return this.getState();
    } catch (error) {
      throw this.fail(error, "PLAYBACK_SEEK_FAILED");
    }
  }

  setLoop(enabled: boolean): PlaybackRecord {
    this.assertLoaded();
    if (this.record.loop === enabled) return this.getState();
    this.update({ loop: enabled }, "playback.loopchange");
    return this.getState();
  }

  setPlaybackRate(rate: number): PlaybackRecord {
    this.assertLoaded();
    if (!isPlaybackRate(rate)) throw new PlaybackEngineError("PLAYBACK_INVALID_RATE", undefined, { rate });
    const source = this.requireSource();
    if (this.record.playbackRate === rate) return this.getState();
    if (source.kind === "image" && this.record.state === "PLAYING") this.consumeImageTime();
    try {
      if (source.kind === "video") source.element.playbackRate = rate;
      this.update({ playbackRate: rate }, "playback.ratechange");
      if (source.kind === "image" && this.record.state === "PLAYING") this.scheduleImageEnd();
      return this.getState();
    } catch (error) {
      throw this.fail(error, "PLAYBACK_INVALID_RATE");
    }
  }

  getState(): PlaybackRecord {
    return cloneRecord(this.record);
  }

  dispose(): PlaybackRecord {
    if (this.disposed) return this.getState();
    let record = this.record;
    if (record.state !== "STOPPED" && record.state !== "IDLE" && record.state !== "LOADING") {
      try {
        record = this.stop();
      } catch {
        // Listener and reference cleanup must proceed even if the browser rejects a final seek.
      }
    }
    this.clearImageTimer(false);
    this.metadataWaitCleanup?.();
    this.metadataWaitCleanup = null;
    for (const { type, listener } of this.videoListeners.splice(0)) {
      if (this.source?.kind === "video") this.source.element.removeEventListener(type, listener);
    }
    if (this.source?.kind === "video") {
      try { this.source.element.pause(); } catch { /* Release references even if pause fails. */ }
    }
    this.source = null;
    this.disposed = true;
    return this.getState();
  }

  private attachVideoListeners(video: HTMLVideoElement): void {
    const listeners: Array<[string, EventListener]> = [
      ["play", () => this.handleVideoPlay()],
      ["pause", () => this.handleVideoPause()],
      ["timeupdate", () => this.handleVideoTimeUpdate()],
      ["loadedmetadata", () => this.handleLoadedMetadata()],
      ["ratechange", () => this.handleVideoRateChange()],
      ["ended", () => this.handleVideoEnded()],
      ["error", () => this.handleVideoError()],
    ];
    for (const [type, listener] of listeners) {
      video.addEventListener(type, listener);
      this.videoListeners.push({ type, listener });
    }
  }

  private waitForMetadata(video: HTMLVideoElement): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const cleanup = (): void => {
        if (timer !== null) this.clearTimer(timer);
        video.removeEventListener("loadedmetadata", onMetadata);
        video.removeEventListener("error", onError);
        this.metadataWaitCleanup = null;
      };
      const finish = (error?: PlaybackEngineError): void => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error === undefined) resolve();
        else reject(error);
      };
      const onMetadata = (): void => finish();
      const onError = (): void => finish(new PlaybackEngineError("PLAYBACK_LOAD_FAILED", "Video metadata could not be read.", { mediaId: this.mediaId }));
      timer = this.setTimer(() => finish(new PlaybackEngineError("PLAYBACK_LOAD_FAILED", "Timed out waiting for video metadata.", { mediaId: this.mediaId })), this.metadataTimeoutMs);
      video.addEventListener("loadedmetadata", onMetadata, { once: true });
      video.addEventListener("error", onError, { once: true });
      this.metadataWaitCleanup = () => finish(new PlaybackEngineError("PLAYBACK_DISPOSED"));
    });
  }

  private handleLoadedMetadata(): void {
    if (this.disposed) return;
    this.syncVideoDuration();
    if (this.pendingSeek !== null) this.applyPendingSeek();
  }

  private syncVideoDuration(): void {
    const source = this.source;
    if (source?.kind !== "video") return;
    const duration = finiteDuration(source.element.duration);
    this.update({ duration, currentTime: this.pendingSeek === null ? this.readVideoTime() : this.record.currentTime });
  }

  private applyPendingSeek(): void {
    const source = this.source;
    const pending = this.pendingSeek;
    if (source?.kind !== "video" || pending === null) return;
    const duration = finiteDuration(source.element.duration);
    const target = Math.max(0, duration === null ? pending : Math.min(pending, duration));
    try {
      source.element.currentTime = target;
      this.pendingSeek = null;
      this.update({ currentTime: target }, "playback.seek");
    } catch (error) {
      this.pendingSeek = null;
      this.fail(error, "PLAYBACK_SEEK_FAILED");
    }
  }

  private handleVideoPlay(): void {
    if (this.disposed || this.record.state === "PLAYING") return;
    if (!canTransitionPlaybackState(this.record.state, "PLAYING")) return;
    this.transition("PLAYING", "playback.play", { startedAt: this.now(), error: null });
  }

  private handleVideoPause(): void {
    if (this.disposed || this.record.state !== "PLAYING") return;
    this.update({ currentTime: this.readVideoTime() });
    this.transition("PAUSED", "playback.pause");
  }

  private handleVideoTimeUpdate(): void {
    if (this.disposed) return;
    const currentTime = this.readVideoTime();
    const now = this.now();
    this.record = { ...this.record, currentTime, updatedAt: now };
    if (now - this.lastTimeUpdateAt >= TIMEUPDATE_THROTTLE_MS) {
      this.lastTimeUpdateAt = now;
      this.emit("playback.timeupdate");
    }
  }

  private handleVideoRateChange(): void {
    if (this.disposed) return;
    const source = this.source;
    if (source?.kind !== "video") return;
    const rate = source.element.playbackRate;
    if (isPlaybackRate(rate) && rate !== this.record.playbackRate) this.update({ playbackRate: rate }, "playback.ratechange");
  }

  private handleVideoEnded(): void {
    if (this.disposed || this.record.state !== "PLAYING") return;
    const source = this.source;
    if (source?.kind !== "video") return;
    const duration = finiteDuration(source.element.duration);
    if (this.record.loop) {
      try {
        source.element.currentTime = 0;
        this.update({ currentTime: 0 }, "playback.loop");
        void source.element.play().then(() => {
          if (!this.disposed && this.record.state !== "PLAYING" && canTransitionPlaybackState(this.record.state, "PLAYING")) {
            this.transition("PLAYING", "playback.play", { startedAt: this.now() });
          }
        }).catch((error: unknown) => { this.fail(error, "PLAYBACK_PLAY_FAILED"); });
      } catch (error) {
        this.fail(error, "PLAYBACK_PLAY_FAILED");
      }
      return;
    }
    this.transition("ENDED", "playback.ended", {
      currentTime: duration ?? this.readVideoTime(),
      startedAt: this.record.startedAt,
    });
  }

  private handleVideoError(): void {
    if (this.disposed) return;
    const source = this.source;
    const mediaError = source?.kind === "video" ? source.element.error : null;
    const failure = new PlaybackEngineError("PLAYBACK_LOAD_FAILED", "The browser reported a video playback error.", {
      mediaId: this.mediaId,
      mediaErrorCode: mediaError?.code ?? null,
    });
    this.lastFailure = failure;
    this.metadataWaitCleanup?.();
    this.fail(failure, "PLAYBACK_LOAD_FAILED");
  }

  private scheduleImageEnd(): void {
    this.clearImageTimer(false);
    if (this.record.state !== "PLAYING" || this.record.duration === null || this.imageRemainingMs === null) return;
    const rate = this.record.playbackRate;
    const delay = Math.max(0, this.imageRemainingMs / rate);
    this.imageTimerStartedAt = this.now();
    try {
      this.imageTimer = this.setTimer(() => {
        this.imageTimer = null;
        this.imageTimerStartedAt = null;
        this.imageRemainingMs = 0;
        if (this.disposed || this.record.state !== "PLAYING") return;
        if (this.record.loop) {
          this.imageRemainingMs = (this.record.duration ?? 0) * 1000;
          this.update({ currentTime: 0 }, "playback.loop");
          try {
            this.scheduleImageEnd();
          } catch (error) {
            this.fail(error, "PLAYBACK_PLAY_FAILED");
          }
        } else {
          this.transition("ENDED", "playback.ended", { currentTime: 0 });
        }
      }, delay);
    } catch (error) {
      this.imageTimerStartedAt = null;
      throw this.fail(error, "PLAYBACK_PLAY_FAILED");
    }
  }

  private consumeImageTime(): void {
    if (this.imageTimer !== null && this.imageTimerStartedAt !== null && this.imageRemainingMs !== null) {
      const elapsed = Math.max(0, this.now() - this.imageTimerStartedAt) * this.record.playbackRate;
      this.imageRemainingMs = Math.max(0, this.imageRemainingMs - elapsed);
    }
    this.clearImageTimer(false);
  }

  private clearImageTimer(consume: boolean): void {
    if (consume) this.consumeImageTime();
    else if (this.imageTimer !== null) this.clearTimer(this.imageTimer);
    this.imageTimer = null;
    this.imageTimerStartedAt = null;
  }

  private readVideoTime(): number {
    const source = this.source;
    if (source?.kind !== "video") return 0;
    const value = source.element.currentTime;
    const duration = finiteDuration(source.element.duration);
    if (!Number.isFinite(value) || value < 0) return 0;
    return duration === null ? value : Math.min(value, duration);
  }

  private transition(state: PlaybackRecord["state"], event: PlaybackEventType, patch: Partial<PlaybackRecord> = {}): void {
    const next = transitionPlaybackState(this.record.state, state);
    this.record = { ...this.record, ...patch, state: next, updatedAt: this.now() };
    this.emit(event);
  }

  private update(patch: Partial<PlaybackRecord>, event?: PlaybackEventType): void {
    this.record = { ...this.record, ...patch, updatedAt: this.now() };
    if (event !== undefined) this.emit(event);
  }

  private emit(type: PlaybackEventType): void {
    try {
      this.publishEvent(type, this.getState());
    } catch {
      // Event delivery is advisory; it must not interrupt browser playback or cleanup.
    }
  }

  private fail(error: unknown, fallback: "PLAYBACK_LOAD_FAILED" | "PLAYBACK_PLAY_FAILED" | "PLAYBACK_SEEK_FAILED" | "PLAYBACK_INVALID_STATE" | "PLAYBACK_INVALID_RATE"): PlaybackEngineError {
    const failure = toPlaybackEngineError(error, fallback);
    this.lastFailure = failure;
    if (!this.disposed && this.record.state !== "ERROR") {
      if (canTransitionPlaybackState(this.record.state, "ERROR")) {
        this.transition("ERROR", "playback.error", { error: failure.toInfo() });
      } else {
        this.update({ error: failure.toInfo() }, "playback.error");
      }
    }
    return failure;
  }

  private recordError(): PlaybackEngineError {
    const error = this.record.error;
    return error === null
      ? new PlaybackEngineError("PLAYBACK_INVALID_STATE", undefined, { state: this.record.state })
      : new PlaybackEngineError(error.code, error.message, error.details);
  }

  private isCurrentlyPlaying(): boolean {
    return this.record.state === "PLAYING";
  }

  private assertActive(): void {
    if (this.disposed) throw new PlaybackEngineError("PLAYBACK_DISPOSED");
  }

  private assertLoaded(allowLoading = false): void {
    this.assertActive();
    if (this.source === null || (this.record.state === "LOADING" && !allowLoading) || this.record.state === "IDLE") {
      throw new PlaybackEngineError("PLAYBACK_INVALID_STATE", undefined, { state: this.record.state });
    }
  }

  private requireSource(): RenderableMediaSource {
    if (this.source === null) throw new PlaybackEngineError("PLAYBACK_DISPOSED");
    return this.source;
  }
}
