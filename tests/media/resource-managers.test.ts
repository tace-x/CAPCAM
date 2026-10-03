import { describe, expect, it } from "vitest";
import { ImageResourceManager, type ImageElementLike } from "../../src/media/image-resource-manager";
import { VideoResourceManager, type VideoElementLike } from "../../src/media/video-resource-manager";

class FakeImage implements ImageElementLike {
  private currentSrc = "";
  complete = false;
  naturalWidth = 640;
  naturalHeight = 480;
  decodeTask: Promise<void> = Promise.resolve();
  removed = false;
  private readonly listeners = new Map<string, Set<EventListener>>();

  get src(): string {
    return this.currentSrc;
  }

  set src(value: string) {
    this.currentSrc = value;
    if (value !== "") this.dispatch("load");
  }

  addEventListener(type: string, listener: EventListener): void {
    const listeners = this.listeners.get(type) ?? new Set<EventListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: EventListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  removeAttribute(name: string): void {
    if (name === "src") {
      this.src = "";
      this.removed = true;
    }
  }

  dispatch(type: string): void {
    const event = new Event(type);
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  decode(): Promise<void> {
    return this.decodeTask;
  }
}

class FakeVideo implements VideoElementLike {
  src = "";
  preload = "";
  muted = false;
  playsInline = false;
  readyState = 0;
  videoWidth = 1280;
  videoHeight = 720;
  duration = 3.25;
  error: { code: number } | null = null;
  seekable = { length: 1 };
  loadCalls = 0;
  pauseCalls = 0;
  playCalls = 0;
  loop = false;
  ended = false;
  currentTime = 0;
  private readonly listeners = new Map<string, Set<EventListener>>();

  canPlayType(): string {
    return "probably";
  }

  load(): void {
    this.loadCalls += 1;
    if (this.src !== "") {
      this.readyState = 1;
      queueMicrotask(() => this.dispatch("loadedmetadata"));
    }
  }

  async play(): Promise<void> {
    this.playCalls += 1;
  }

  pause(): void {
    this.pauseCalls += 1;
  }

  addEventListener(type: string, listener: EventListener): void {
    const listeners = this.listeners.get(type) ?? new Set<EventListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: EventListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  removeAttribute(name: string): void {
    if (name === "src") this.src = "";
  }

  dispatch(type: string): void {
    const event = new Event(type);
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

describe("image and video resource managers", () => {
  it("uses async image decode and releases the detached image reference", async () => {
    const image = new FakeImage();
    const manager = new ImageResourceManager(() => image, 100);
    const result = await manager.load("med_image0001", "blob:test/image", new AbortController().signal);

    expect(result).toEqual({ width: 640, height: 480 });
    expect(image.src).toBe("blob:test/image");
    expect(manager.hasImage("med_image0001")).toBe(true);
    expect(manager.getImageElement("med_image0001")).toBe(image);
    await manager.releaseImage("med_image0001");
    expect(manager.getImageElement("med_image0001")).toBeUndefined();
    expect(image.removed).toBe(true);
    expect(manager.hasImage("med_image0001")).toBe(false);
  });

  it("handles image decoder errors, timeout, and abort", async () => {
    const badImage = new FakeImage();
    badImage.decodeTask = Promise.reject(new Error("decode failed"));
    const badManager = new ImageResourceManager(() => badImage, 100);
    await expect(badManager.load("med_image0002", "blob:test/bad", new AbortController().signal))
      .rejects.toMatchObject({ mediaCode: "MEDIA_DECODE_FAILED" });
    expect(badImage.removed).toBe(true);

    const pendingImage = new FakeImage();
    pendingImage.decodeTask = new Promise<void>(() => undefined);
    const timeoutManager = new ImageResourceManager(() => pendingImage, 5);
    await expect(timeoutManager.load("med_image0003", "blob:test/slow", new AbortController().signal, 5))
      .rejects.toMatchObject({ mediaCode: "MEDIA_LOAD_TIMEOUT" });

    const abortedImage = new FakeImage();
    abortedImage.decodeTask = new Promise<void>(() => undefined);
    const abortController = new AbortController();
    const abortManager = new ImageResourceManager(() => abortedImage, 100);
    const loading = abortManager.load("med_image0004", "blob:test/abort", abortController.signal);
    abortController.abort();
    await expect(loading).rejects.toMatchObject({ mediaCode: "MEDIA_CANCELLED" });
  });

  it("waits for video metadata without playing, then stops/releases the element", async () => {
    const video = new FakeVideo();
    const manager = new VideoResourceManager(() => video, 100);
    const result = await manager.load("med_video0001", "blob:test/video", "video/webm", new AbortController().signal);

    expect(result).toEqual({ width: 1280, height: 720, duration: 3.25, canSeek: true, supportsAudio: false });
    expect(video.preload).toBe("metadata");
    expect(video.muted).toBe(true);
    expect(video.playsInline).toBe(true);
    expect(manager.hasVideo("med_video0001")).toBe(true);
    expect(manager.getVideoElement("med_video0001")).toBe(video);
    video.ended = true;
    video.currentTime = 2;
    await manager.playVideo("med_video0001");
    expect(video.playCalls).toBe(1);
    expect(video.currentTime).toBe(0);
    expect(video.loop).toBe(true);
    await manager.pauseVideo("med_video0001");
    expect(video.pauseCalls).toBe(1);
    await manager.releaseVideo("med_video0001");
    expect(video.pauseCalls).toBe(2);
    expect(video.src).toBe("");
    expect(manager.hasVideo("med_video0001")).toBe(false);
  });

  it("rejects unsupported video types and aborts pending metadata loads", async () => {
    const unsupported = new FakeVideo();
    unsupported.canPlayType = () => "";
    const unsupportedManager = new VideoResourceManager(() => unsupported, 100);
    await expect(unsupportedManager.load("med_video0002", "blob:test/video", "video/ogg", new AbortController().signal))
      .rejects.toMatchObject({ mediaCode: "MEDIA_UNSUPPORTED_TYPE" });

    const errorVideo = new FakeVideo();
    errorVideo.error = { code: 4 };
    errorVideo.load = () => {
      errorVideo.loadCalls += 1;
      queueMicrotask(() => errorVideo.dispatch("error"));
    };
    const errorManager = new VideoResourceManager(() => errorVideo, 100);
    await expect(errorManager.load("med_video0004", "blob:test/error", "video/mp4", new AbortController().signal))
      .rejects.toMatchObject({ mediaCode: "MEDIA_UNSUPPORTED_TYPE" });

    const slowVideo = new FakeVideo();
    slowVideo.load = () => { slowVideo.loadCalls += 1; };
    const timeoutManager = new VideoResourceManager(() => slowVideo, 5);
    await expect(timeoutManager.load("med_video0005", "blob:test/slow", "video/webm", new AbortController().signal, 5))
      .rejects.toMatchObject({ mediaCode: "MEDIA_LOAD_TIMEOUT" });

    const pending = new FakeVideo();
    pending.load = () => { pending.loadCalls += 1; };
    const controller = new AbortController();
    const manager = new VideoResourceManager(() => pending, 100);
    const loading = manager.load("med_video0003", "blob:test/pending", "video/webm", controller.signal);
    controller.abort();
    await expect(loading).rejects.toMatchObject({ mediaCode: "MEDIA_CANCELLED" });
    expect(manager.hasVideo("med_video0003")).toBe(false);
  });
});
