import { MediaEngineError } from "./media-errors";
import type { VideoResourceInfo } from "./media-types";

export interface VideoElementLike {
  src: string;
  preload: string;
  muted: boolean;
  playsInline: boolean;
  readyState: number;
  videoWidth: number;
  videoHeight: number;
  duration: number;
  error: { code: number } | null;
  seekable: { length: number };
  loop?: boolean;
  ended?: boolean;
  currentTime?: number;
  canPlayType(type: string): string;
  load(): void;
  play?(): Promise<void>;
  pause(): void;
  addEventListener(type: string, listener: EventListener): void;
  removeEventListener(type: string, listener: EventListener): void;
  removeAttribute(name: string): void;
}

export interface VideoResourceManagerPort {
  load(mediaId: string, sourceUrl: string, mimeType: string, signal: AbortSignal, timeoutMs?: number): Promise<VideoResourceInfo>;
  releaseVideo(mediaId: string): Promise<void>;
  hasVideo(mediaId: string): boolean;
  getVideoElement?(mediaId: string): VideoElementLike | undefined;
  playVideo?(mediaId: string): Promise<void>;
  pauseVideo?(mediaId: string): Promise<void>;
}

function abortError(): MediaEngineError {
  return new MediaEngineError("MEDIA_CANCELLED");
}

function videoFailure(error: unknown, video: VideoElementLike): MediaEngineError {
  if (error instanceof MediaEngineError) return error;
  const code = video.error?.code;
  if (code === 4) return new MediaEngineError("MEDIA_UNSUPPORTED_TYPE", undefined, { mediaErrorCode: code });
  if (code === 3) return new MediaEngineError("MEDIA_DECODE_FAILED", undefined, { mediaErrorCode: code });
  return new MediaEngineError("MEDIA_METADATA_FAILED", undefined, {
    mediaErrorCode: code ?? null,
    reason: error instanceof Error ? error.message : "Video metadata was not available.",
  });
}

export class VideoResourceManager implements VideoResourceManagerPort {
  private readonly videos = new Map<string, VideoElementLike>();

  constructor(
    private readonly createVideo: () => VideoElementLike = () => document.createElement("video"),
    private readonly defaultTimeoutMs = 30_000,
  ) {}

  async load(
    mediaId: string,
    sourceUrl: string,
    mimeType: string,
    signal: AbortSignal,
    timeoutMs = this.defaultTimeoutMs,
  ): Promise<VideoResourceInfo> {
    if (this.videos.has(mediaId)) {
      throw new MediaEngineError("MEDIA_INVALID_STATE", "A video resource already exists for this media ID.", { mediaId });
    }
    if (signal.aborted) throw abortError();

    const video = this.createVideo();
    this.videos.set(mediaId, video);
    video.preload = "metadata";
    video.muted = true;
    video.playsInline = true;

    if (video.canPlayType(mimeType) === "") {
      await this.releaseVideo(mediaId);
      throw new MediaEngineError("MEDIA_UNSUPPORTED_TYPE", "Chrome reports no support for this video MIME type.", { mimeType });
    }

    try {
      await this.waitForMetadata(video, sourceUrl, signal, timeoutMs);
      if (signal.aborted) throw abortError();
      const { videoWidth: width, videoHeight: height, duration } = video;
      if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 || !Number.isFinite(duration) || duration <= 0) {
        throw new MediaEngineError("MEDIA_METADATA_FAILED", undefined, { mediaId, width, height, duration });
      }
      const audioTracks = (video as VideoElementLike & { audioTracks?: { length: number } }).audioTracks;
      return {
        width,
        height,
        duration,
        canSeek: video.seekable.length > 0 || duration > 0,
        supportsAudio: audioTracks !== undefined && audioTracks.length > 0,
      };
    } catch (error) {
      await this.releaseVideo(mediaId);
      throw videoFailure(error, video);
    }
  }

  async releaseVideo(mediaId: string): Promise<void> {
    const video = this.videos.get(mediaId);
    if (video === undefined) return;
    this.videos.delete(mediaId);
    try {
      video.pause();
      video.removeAttribute("src");
      video.load();
    } catch (error) {
      throw new MediaEngineError("MEDIA_RESOURCE_FAILED", "CapCam could not release the video decoder resource.", {
        reason: error instanceof Error ? error.message : "Unknown video release failure.",
      });
    }
  }

  hasVideo(mediaId: string): boolean {
    return this.videos.has(mediaId);
  }

  getVideoElement(mediaId: string): VideoElementLike | undefined {
    return this.videos.get(mediaId);
  }

  async playVideo(mediaId: string): Promise<void> {
    const video = this.videos.get(mediaId);
    if (video === undefined) throw new MediaEngineError("MEDIA_NOT_FOUND", undefined, { mediaId });
    if (video.play === undefined) throw new MediaEngineError("MEDIA_RESOURCE_FAILED", "This video resource cannot be played in the current context.", { mediaId });
    video.muted = true;
    video.playsInline = true;
    if (video.loop !== undefined) video.loop = true;
    if (video.ended === true && typeof video.currentTime === "number") video.currentTime = 0;
    try {
      await video.play();
    } catch (error) {
      throw new MediaEngineError("MEDIA_RESOURCE_FAILED", "The local video could not be started for canvas rendering.", {
        mediaId,
        reason: error instanceof Error ? error.message : "HTMLVideoElement.play() failed.",
      });
    }
  }

  async pauseVideo(mediaId: string): Promise<void> {
    const video = this.videos.get(mediaId);
    if (video === undefined) return;
    try {
      video.pause();
    } catch (error) {
      throw new MediaEngineError("MEDIA_RESOURCE_FAILED", "The local video could not be paused cleanly.", {
        mediaId,
        reason: error instanceof Error ? error.message : "HTMLVideoElement.pause() failed.",
      });
    }
  }

  private waitForMetadata(video: VideoElementLike, sourceUrl: string, signal: AbortSignal, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const cleanup = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        video.removeEventListener("loadedmetadata", onLoadedMetadata);
        video.removeEventListener("error", onError);
      };
      const finish = (error?: MediaEngineError): void => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error === undefined) resolve();
        else reject(error);
      };
      const onAbort = (): void => finish(abortError());
      const onLoadedMetadata = (): void => finish();
      const onError = (): void => finish(videoFailure(undefined, video));

      if (signal.aborted) {
        finish(abortError());
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      video.addEventListener("loadedmetadata", onLoadedMetadata);
      video.addEventListener("error", onError);
      timer = setTimeout(() => finish(new MediaEngineError("MEDIA_LOAD_TIMEOUT")), timeoutMs);

      try {
        video.src = sourceUrl;
        video.load();
        if (video.readyState >= 1 && video.videoWidth > 0 && video.videoHeight > 0) finish();
      } catch (error) {
        finish(videoFailure(error, video));
      }
    });
  }
}
