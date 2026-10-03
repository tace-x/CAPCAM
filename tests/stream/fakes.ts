import { vi } from "vitest";
import { CanvasManager } from "../../src/canvas/canvas-manager";
import type { CanvasSurface } from "../../src/canvas/canvas-manager";
import type { RenderableMediaSource } from "../../src/canvas/render-types";
import type { FrameSchedulerPort } from "../../src/canvas/frame-scheduler";
import type { StreamFactoryPort } from "../../src/stream/stream-factory";
import type { StreamMediaSourceProvider } from "../../src/stream/stream-types";

export const TEST_RENDER_CONFIG = {
  width: 1280,
  height: 720,
  fps: 30,
  fitMode: "cover" as const,
  mirror: false,
};

export interface FakeCanvasFixture {
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
  surface: CanvasSurface;
}

export function createFakeCanvasFixture(): FakeCanvasFixture {
  const context = {
    save: vi.fn(),
    restore: vi.fn(),
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    translate: vi.fn(),
    scale: vi.fn(),
    drawImage: vi.fn(),
    fillStyle: "#000000",
  } as unknown as CanvasRenderingContext2D;
  const canvas = {
    width: 0,
    height: 0,
    getContext: vi.fn(() => context),
  } as unknown as HTMLCanvasElement;
  return { canvas, context, surface: { canvas, context } };
}

export function createCanvasManager(fixture: FakeCanvasFixture): CanvasManager {
  return new CanvasManager(() => fixture.canvas);
}

export class FakeTrack {
  readonly kind = "video";
  readonly id: string;
  readonly label = "CapCam canvas capture";
  readyState: MediaStreamTrackState = "live";
  enabled = true;
  muted = false;
  stopCalls = 0;

  constructor(id: string, private readonly settings: MediaTrackSettings = {
    width: 1280,
    height: 720,
    frameRate: 30,
    aspectRatio: 16 / 9,
  }) {
    this.id = id;
  }

  getSettings(): MediaTrackSettings {
    return { ...this.settings };
  }

  stop(): void {
    this.stopCalls += 1;
    this.readyState = "ended";
  }

  addEventListener(): void { return undefined; }
  removeEventListener(): void { return undefined; }
  dispatchEvent(): boolean { return true; }
  getConstraints(): MediaTrackConstraints { return {}; }
  getCapabilities(): MediaTrackCapabilities { return {}; }
  applyConstraints(): Promise<void> { return Promise.resolve(); }
  clone(): MediaStreamTrack { return this as unknown as MediaStreamTrack; }
}

export function createFakeMediaStream(track: FakeTrack): MediaStream {
  return {
    id: `stream-${track.id}`,
    active: track.readyState === "live",
    getTracks: () => [track as unknown as MediaStreamTrack],
    getVideoTracks: () => [track as unknown as MediaStreamTrack],
    getAudioTracks: () => [],
    addTrack: vi.fn(),
    removeTrack: vi.fn(),
    clone: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(() => true),
  } as unknown as MediaStream;
}

export class FakeStreamFactory implements StreamFactoryPort {
  readonly tracks: FakeTrack[] = [];
  readonly streams: MediaStream[] = [];
  readonly createFromCanvas = vi.fn((_canvas: HTMLCanvasElement, _fps: number): MediaStream => {
    const track = new FakeTrack(`track-${this.tracks.length + 1}`);
    const stream = createFakeMediaStream(track);
    this.tracks.push(track);
    this.streams.push(stream);
    return stream;
  });
}

export class FakeScheduler implements FrameSchedulerPort {
  running = false;
  disposed = false;
  startCalls = 0;
  stopCalls = 0;

  constructor(
    private readonly renderFrame: () => void = () => undefined,
    private readonly onError: (error: unknown) => void = () => undefined,
  ) {}

  start(): void {
    if (this.disposed) throw new Error("fake scheduler disposed");
    this.startCalls += 1;
    this.running = true;
  }

  stop(): void {
    this.stopCalls += 1;
    this.running = false;
  }

  isRunning(): boolean {
    return this.running;
  }

  dispose(): void {
    this.stop();
    this.disposed = true;
  }

  render(): void {
    try {
      this.renderFrame();
    } catch (error) {
      this.running = false;
      this.onError(error);
    }
  }
}

export function createImageSource(mediaId: string, width = 640, height = 480): Extract<RenderableMediaSource, { kind: "image" }> {
  const image = {
    complete: true,
    naturalWidth: width,
    naturalHeight: height,
  } as HTMLImageElement;
  return { mediaId, kind: "image", width, height, element: image };
}

export function createVideoSource(mediaId: string, width = 1920, height = 1080): Extract<RenderableMediaSource, { kind: "video" }> {
  const video = {
    readyState: 2,
    videoWidth: width,
    videoHeight: height,
  } as HTMLVideoElement;
  return { mediaId, kind: "video", width, height, element: video };
}

export class FakeSourceProvider implements StreamMediaSourceProvider {
  readonly sources = new Map<string, RenderableMediaSource>();
  readonly playCalls: string[] = [];
  readonly pauseCalls: string[] = [];

  add(source: RenderableMediaSource): void {
    this.sources.set(source.mediaId, source);
  }

  getRenderableSource(mediaId: string): RenderableMediaSource {
    const source = this.sources.get(mediaId);
    if (source === undefined) throw new Error(`Missing local source: ${mediaId}`);
    return source;
  }

  async playVideo(mediaId: string): Promise<void> {
    this.playCalls.push(mediaId);
  }

  async pauseVideo(mediaId: string): Promise<void> {
    this.pauseCalls.push(mediaId);
  }
}
