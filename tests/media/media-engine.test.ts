import { describe, expect, it } from "vitest";
import { MediaEngine } from "../../src/media/media-engine";
import { MediaEngineError } from "../../src/media/media-errors";
import { ObjectUrlManager, type ObjectUrlApi } from "../../src/media/object-url-manager";
import type { ImageResourceManagerPort } from "../../src/media/image-resource-manager";
import type { VideoResourceManagerPort } from "../../src/media/video-resource-manager";
import type { ImageResourceInfo, MediaRecord, VideoResourceInfo } from "../../src/media/media-types";
import type { MediaTransferStore } from "../../src/media/media-transfer-store";
import type { EventEnvelope } from "../../src/messaging/events";
import { createCorruptPngFile, createPngFile, createWebmHeaderFile } from "./fixtures";

class MemoryTransferStore implements MediaTransferStore {
  private readonly files = new Map<string, File>();
  private nextId = 0;

  async stage(file: File): Promise<string> {
    this.nextId += 1;
    const transferId = `transfer_fixture${this.nextId.toString().padStart(4, "0")}`;
    this.files.set(transferId, file);
    return transferId;
  }

  async take(transferId: string): Promise<File> {
    const file = this.files.get(transferId);
    this.files.delete(transferId);
    if (file === undefined) throw new MediaEngineError("MEDIA_TRANSFER_FAILED");
    return file;
  }

  async delete(transferId: string): Promise<void> {
    this.files.delete(transferId);
  }

  async clearExpired(): Promise<number> {
    return 0;
  }
}

class FakeObjectUrlApi implements ObjectUrlApi {
  created: string[] = [];
  revoked: string[] = [];

  createObjectURL(_file: Blob): string {
    const url = `blob:engine-test/${this.created.length + 1}`;
    this.created.push(url);
    return url;
  }

  revokeObjectURL(url: string): void {
    this.revoked.push(url);
  }
}

class FakeImageResources implements ImageResourceManagerPort {
  loaded: string[] = [];
  released: string[] = [];
  result: ImageResourceInfo = { width: 1920, height: 1080 };
  failure: MediaEngineError | null = null;
  pending: Promise<ImageResourceInfo> | null = null;

  async load(mediaId: string, _url: string, _signal: AbortSignal, _timeout?: number): Promise<ImageResourceInfo> {
    this.loaded.push(mediaId);
    if (this.pending !== null) return this.pending;
    if (this.failure !== null) throw this.failure;
    return { ...this.result };
  }

  async releaseImage(mediaId: string): Promise<void> {
    this.released.push(mediaId);
  }

  hasImage(mediaId: string): boolean {
    return this.loaded.includes(mediaId) && !this.released.includes(mediaId);
  }
}

class FakeVideoResources implements VideoResourceManagerPort {
  loaded: string[] = [];
  released: string[] = [];
  result: VideoResourceInfo = { width: 1920, height: 1080, duration: 2.5, canSeek: true, supportsAudio: false };
  failure: MediaEngineError | null = null;

  async load(mediaId: string, _url: string, _mimeType: string, _signal: AbortSignal, _timeout?: number): Promise<VideoResourceInfo> {
    this.loaded.push(mediaId);
    if (this.failure !== null) throw this.failure;
    return { ...this.result };
  }

  async releaseVideo(mediaId: string): Promise<void> {
    this.released.push(mediaId);
  }

  hasVideo(mediaId: string): boolean {
    return this.loaded.includes(mediaId) && !this.released.includes(mediaId);
  }
}

function setup(options: {
  maxMediaSizeBytes?: number;
  maxConcurrentLoads?: number;
  imageResult?: ImageResourceInfo;
  videoResult?: VideoResourceInfo;
  imageFailure?: MediaEngineError;
  videoFailure?: MediaEngineError;
  imagePending?: Promise<ImageResourceInfo>;
  events?: EventEnvelope[];
} = {}) {
  const transfers = new MemoryTransferStore();
  const urlApi = new FakeObjectUrlApi();
  const objectUrls = new ObjectUrlManager(urlApi);
  const images = new FakeImageResources();
  const videos = new FakeVideoResources();
  if (options.imageResult !== undefined) images.result = options.imageResult;
  if (options.videoResult !== undefined) videos.result = options.videoResult;
  if (options.imageFailure !== undefined) images.failure = options.imageFailure;
  if (options.videoFailure !== undefined) videos.failure = options.videoFailure;
  if (options.imagePending !== undefined) images.pending = options.imagePending;
  const engine = new MediaEngine({
    transferStore: transfers,
    objectUrls,
    imageResources: images,
    videoResources: videos,
    ...(options.maxMediaSizeBytes === undefined ? {} : { maxMediaSizeBytes: options.maxMediaSizeBytes }),
    ...(options.maxConcurrentLoads === undefined ? {} : { maxConcurrentLoads: options.maxConcurrentLoads }),
    ...(options.events === undefined ? {} : { publishEvent: (event) => options.events?.push(event) }),
  });
  return { engine, transfers, urlApi, objectUrls, images, videos };
}

async function stagedRegister(engine: MediaEngine, transfers: MemoryTransferStore, file: File): Promise<MediaRecord> {
  const transferId = await transfers.stage(file);
  return engine.register(transferId);
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const startedAt = Date.now();
  await new Promise<void>((resolve, reject) => {
    const check = (): void => {
      if (predicate()) {
        resolve();
      } else if (Date.now() - startedAt >= timeoutMs) {
        reject(new Error("Timed out waiting for media engine state."));
      } else {
        setTimeout(check, 1);
      }
    };
    check();
  });
}

describe("local media engine", () => {
  it("loads landscape, portrait, and square image metadata; duplicate names remain independent", async () => {
    const { engine, transfers, images } = setup({ imageResult: { width: 1920, height: 1080 } });
    await engine.initialize();
    const first = await stagedRegister(engine, transfers, createPngFile(16, 9, "demo.png"));
    images.result = { width: 1080, height: 1920 };
    const second = await stagedRegister(engine, transfers, createPngFile(9, 16, "demo.png"));
    images.result = { width: 1000, height: 1000 };
    const square = await stagedRegister(engine, transfers, createPngFile(1, 1, "square.png"));

    expect(first.kind).toBe("image");
    expect(first.status).toBe("READY");
    expect(first.width).toBe(1920);
    expect(first.height).toBe(1080);
    expect(first.aspectRatio).toBeCloseTo(16 / 9);
    expect(first.duration).toBeNull();
    expect(first.capabilities.canDecode).toBe(true);
    expect(second.id).not.toBe(first.id);
    expect(second.aspectRatio).toBeCloseTo(9 / 16);
    expect(square.aspectRatio).toBe(1);
    expect(engine.list()).toHaveLength(3);
    expect(images.loaded).toHaveLength(3);
  });

  it("loads portrait/longer video metadata without starting playback", async () => {
    const { engine, transfers, videos } = setup({
      videoResult: { width: 720, height: 1280, duration: 185, canSeek: true, supportsAudio: true },
    });
    await engine.initialize();
    const record = await stagedRegister(engine, transfers, createWebmHeaderFile("portrait.webm"));

    expect(record.kind).toBe("video");
    expect(record.status).toBe("READY");
    expect(record.width).toBe(720);
    expect(record.height).toBe(1280);
    expect(record.aspectRatio).toBeCloseTo(9 / 16);
    expect(record.duration).toBe(185);
    expect(record.capabilities.canSeek).toBe(true);
    expect(record.capabilities.supportsAudio).toBe(true);
    expect(videos.loaded).toContain(record.id);
  });

  it("records landscape and short video metadata", async () => {
    const { engine, transfers } = setup({
      videoResult: { width: 1920, height: 1080, duration: 2.5, canSeek: true, supportsAudio: false },
    });
    await engine.initialize();
    const record = await stagedRegister(engine, transfers, createWebmHeaderFile("short.webm"));
    expect(record.aspectRatio).toBeCloseTo(16 / 9);
    expect(record.duration).toBe(2.5);
  });

  it("releases image/video resources and revokes object URLs on removal", async () => {
    const { engine, transfers, images, videos, urlApi } = setup();
    await engine.initialize();
    const image = await stagedRegister(engine, transfers, createPngFile());
    const video = await stagedRegister(engine, transfers, createWebmHeaderFile());

    const [releasedImage, repeatedRelease] = await Promise.all([engine.remove(image.id), engine.remove(image.id)]);
    const releasedVideo = await engine.remove(video.id);
    expect(repeatedRelease).toEqual(releasedImage);
    expect(releasedImage.status).toBe("RELEASED");
    expect(releasedImage.sourceUrl).toBeNull();
    expect(releasedVideo.status).toBe("RELEASED");
    expect(engine.has(image.id)).toBe(false);
    expect(() => engine.get(video.id)).toThrowError(MediaEngineError);
    expect(images.released).toContain(image.id);
    expect(videos.released).toContain(video.id);
    expect(urlApi.revoked).toHaveLength(2);
  });

  it("rejects empty, unsupported, and oversized files with structured media errors", async () => {
    const { engine, transfers } = setup({ maxMediaSizeBytes: 8 });
    await engine.initialize();

    await expect(stagedRegister(engine, transfers, new File([], "empty.png", { type: "image/png" })))
      .rejects.toMatchObject({ mediaCode: "MEDIA_INVALID_FILE" });
    await expect(stagedRegister(engine, transfers, new File(["bad"], "notes.txt", { type: "text/plain" })))
      .rejects.toMatchObject({ mediaCode: "MEDIA_UNSUPPORTED_TYPE" });
    await expect(stagedRegister(engine, transfers, createPngFile()))
      .rejects.toMatchObject({ mediaCode: "MEDIA_TOO_LARGE" });
    expect(engine.list()).toHaveLength(0);
  });

  it("keeps decoder failures inspectable while cleaning their resources", async () => {
    const events: EventEnvelope[] = [];
    const { engine, transfers, images, urlApi } = setup({
      imageFailure: new MediaEngineError("MEDIA_DECODE_FAILED"),
      events,
    });
    await engine.initialize();

    await expect(stagedRegister(engine, transfers, createCorruptPngFile()))
      .rejects.toMatchObject({ mediaCode: "MEDIA_DECODE_FAILED" });
    const failed = engine.list()[0];
    expect(failed?.status).toBe("ERROR");
    expect(failed?.error?.code).toBe("MEDIA_DECODE_FAILED");
    expect(urlApi.revoked).toHaveLength(1);
    expect(images.released).toContain(failed?.id);
    expect(events.some((event) => event.type === "media.failed")).toBe(true);
  });

  it("recovers and decodes the next item after a corrupt image failure", async () => {
    const { engine, transfers, images, urlApi } = setup({ imageFailure: new MediaEngineError("MEDIA_DECODE_FAILED") });
    await engine.initialize();
    await expect(stagedRegister(engine, transfers, createCorruptPngFile()))
      .rejects.toMatchObject({ mediaCode: "MEDIA_DECODE_FAILED" });

    images.failure = null;
    const recovered = await stagedRegister(engine, transfers, createPngFile(4, 3, "recovered.png"));
    expect(recovered.status).toBe("READY");
    expect(recovered.name).toBe("recovered.png");
    expect(urlApi.revoked).toHaveLength(1);
    expect(engine.list()).toHaveLength(2);
    await engine.remove(recovered.id);
  });

  it("cancels a loading item on removal and ignores late decoder results", async () => {
    let resolveLoad: ((value: ImageResourceInfo) => void) | undefined;
    const pendingLoad = new Promise<ImageResourceInfo>((resolve) => { resolveLoad = resolve; });
    const events: EventEnvelope[] = [];
    const { engine, transfers, urlApi } = setup({ imagePending: pendingLoad, events });
    await engine.initialize();
    const transferId = await transfers.stage(createPngFile());
    const registerTask = engine.register(transferId);
    const loadingEvent = await new Promise<MediaRecord>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Loading event did not arrive.")), 1_000);
      const poll = (): void => {
        const loading = events.find((event) => event.type === "media.loading");
        if (loading?.type === "media.loading") {
          clearTimeout(timer);
          resolve(loading.payload.record);
        } else {
          setTimeout(poll, 0);
        }
      };
      poll();
    });

    const removeTask = engine.remove(loadingEvent.id);
    resolveLoad?.({ width: 640, height: 480 });
    const released = await removeTask;
    await expect(registerTask).rejects.toMatchObject({ mediaCode: "MEDIA_CANCELLED" });

    expect(released.status).toBe("RELEASED");
    expect(engine.has(loadingEvent.id)).toBe(false);
    expect(events.some((event) => event.type === "media.ready")).toBe(false);
    expect(urlApi.revoked).toHaveLength(1);
  });

  it("bounds concurrent decodes and cancels a queued upload without blocking the active item", async () => {
    let resolveFirst: ((value: ImageResourceInfo) => void) | undefined;
    const pending = new Promise<ImageResourceInfo>((resolve) => { resolveFirst = resolve; });
    const events: EventEnvelope[] = [];
    const { engine, transfers, images } = setup({ maxConcurrentLoads: 1, imagePending: pending, events });
    await engine.initialize();
    const firstTransfer = await transfers.stage(createPngFile(1, 1, "first.png"));
    const secondTransfer = await transfers.stage(createPngFile(1, 1, "second.png"));
    const firstTask = engine.register(firstTransfer);
    const secondTask = engine.register(secondTransfer);

    await waitFor(() => events.filter((event) => event.type === "media.registered").length === 2 &&
      events.some((event) => event.type === "media.loading"));
    expect(images.loaded).toHaveLength(1);
    const loadingEvent = events.find((event) => event.type === "media.loading");
    if (loadingEvent?.type !== "media.loading") throw new Error("Expected an active media load.");
    const queuedEvent = events.find((event) => event.type === "media.registered" && event.payload.mediaId !== loadingEvent.payload.mediaId);
    if (queuedEvent?.type !== "media.registered") throw new Error("Expected a queued media registration.");

    const queuedRemoval = engine.remove(queuedEvent.payload.mediaId);
    await expect(secondTask).rejects.toMatchObject({ mediaCode: "MEDIA_CANCELLED" });
    expect((await queuedRemoval).status).toBe("RELEASED");
    expect(images.loaded).toHaveLength(1);

    resolveFirst?.({ width: 640, height: 480 });
    expect((await firstTask).status).toBe("READY");
    expect(images.loaded).toEqual([loadingEvent.payload.mediaId]);
    await engine.remove(loadingEvent.payload.mediaId);
  });

  it("releases registered media during shutdown and permits a clean runtime restart", async () => {
    const { engine, transfers, images, videos, objectUrls, urlApi } = setup();
    await engine.initialize();
    const image = await stagedRegister(engine, transfers, createPngFile());
    const video = await stagedRegister(engine, transfers, createWebmHeaderFile());

    await engine.shutdown();
    expect(engine.list()).toEqual([]);
    expect(images.released).toContain(image.id);
    expect(videos.released).toContain(video.id);
    expect(objectUrls.size).toBe(0);
    expect(urlApi.revoked).toHaveLength(2);

    await engine.initialize();
    const recovered = await stagedRegister(engine, transfers, createPngFile(3, 2, "after-shutdown.png"));
    expect(recovered.status).toBe("READY");
    await engine.shutdown();
  });

  it("clears all registered media and publishes lifecycle events", async () => {
    const events: EventEnvelope[] = [];
    const { engine, transfers, urlApi } = setup({ events });
    await engine.initialize();
    await stagedRegister(engine, transfers, createPngFile());
    await stagedRegister(engine, transfers, createWebmHeaderFile());

    expect(await engine.clear()).toEqual({ removed: 2 });
    expect(engine.list()).toHaveLength(0);
    expect(urlApi.revoked).toHaveLength(2);
    expect(events.some((event) => event.type === "media.registered")).toBe(true);
    expect(events.some((event) => event.type === "media.released")).toBe(true);
    expect(events.some((event) => event.type === "media.removed")).toBe(true);
  });
});
