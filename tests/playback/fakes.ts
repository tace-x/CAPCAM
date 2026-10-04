import { vi } from "vitest";
import type { RenderableMediaSource } from "../../src/canvas/render-types";
import type { PlaybackSourceProvider } from "../../src/playback/playback-types";

export class FakePlaybackVideo {
  readyState = 4;
  videoWidth = 640;
  videoHeight = 480;
  duration = 12;
  currentTime = 0;
  playbackRate = 1;
  loop = false;
  muted = true;
  playsInline = true;
  paused = true;
  ended = false;
  error: MediaError | null = null;
  playFailure: Error | null = null;
  private readonly listeners = new Map<string, Set<EventListener>>();
  readonly play = vi.fn(async (): Promise<void> => {
    if (this.playFailure !== null) throw this.playFailure;
    this.paused = false;
    this.ended = false;
    this.dispatch("play");
  });
  readonly pause = vi.fn((): void => {
    const wasPaused = this.paused;
    this.paused = true;
    if (!wasPaused) this.dispatch("pause");
  });
  readonly addEventListener = vi.fn((type: string, listener: EventListener): void => {
    const listeners = this.listeners.get(type) ?? new Set<EventListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  });
  readonly removeEventListener = vi.fn((type: string, listener: EventListener): void => {
    this.listeners.get(type)?.delete(listener);
  });

  dispatch(type: string): void {
    for (const listener of Array.from(this.listeners.get(type) ?? [])) listener(new Event(type));
  }

  listenerCount(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }

  end(): void {
    this.ended = true;
    this.paused = true;
    this.currentTime = this.duration;
    this.dispatch("ended");
    this.dispatch("pause");
  }
}

export function createFakeVideoSource(mediaId: string, video = new FakePlaybackVideo()): Extract<RenderableMediaSource, { kind: "video" }> {
  return {
    mediaId,
    kind: "video",
    width: video.videoWidth,
    height: video.videoHeight,
    element: video as unknown as HTMLVideoElement,
  };
}

export function createFakeImageSource(mediaId: string): Extract<RenderableMediaSource, { kind: "image" }> {
  const image = {
    complete: true,
    naturalWidth: 640,
    naturalHeight: 480,
  } as HTMLImageElement;
  return { mediaId, kind: "image", width: 640, height: 480, element: image };
}

export class FakePlaybackSourceProvider implements PlaybackSourceProvider {
  readonly sources = new Map<string, RenderableMediaSource>();

  add(source: RenderableMediaSource): void {
    this.sources.set(source.mediaId, source);
  }

  getRenderableSource(mediaId: string): RenderableMediaSource {
    const source = this.sources.get(mediaId);
    if (source === undefined) throw new Error(`Missing source: ${mediaId}`);
    return source;
  }
}
