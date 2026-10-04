import { describe, expect, it, vi } from "vitest";
import { CanvasManager } from "../../src/canvas/canvas-manager";
import { CanvasRenderer } from "../../src/canvas/canvas-renderer";
import { FrameScheduler, type FrameClock } from "../../src/canvas/frame-scheduler";
import { StreamEngineError } from "../../src/stream/stream-errors";
import { StreamFactory } from "../../src/stream/stream-factory";
import { createFakeCanvasFixture, createImageSource, createVideoSource, TEST_RENDER_CONFIG } from "../stream/fakes";

class FakeClock implements FrameClock {
  private timestamp = 0;
  private nextId = 0;
  failure: Error | null = null;
  private readonly timers = new Map<number, { callback: () => void; at: number }>();

  now(): number { return this.timestamp; }

  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout> {
    if (this.failure !== null) throw this.failure;
    this.nextId += 1;
    this.timers.set(this.nextId, { callback, at: this.timestamp + delayMs });
    return this.nextId as unknown as ReturnType<typeof setTimeout>;
  }

  clearTimeout(handle: ReturnType<typeof setTimeout>): void {
    this.timers.delete(handle as unknown as number);
  }

  get pendingCount(): number { return this.timers.size; }

  runNext(): void {
    const [id, timer] = Array.from(this.timers.entries()).sort((left, right) => left[1].at - right[1].at)[0] ?? [];
    if (id === undefined || timer === undefined) throw new Error("No fake timer is pending.");
    this.timers.delete(id);
    this.timestamp = Math.max(this.timestamp, timer.at);
    timer.callback();
  }
}

function fakeCaptureTrack(kind: "video" | "audio" = "video") {
  const track = { kind, stop: vi.fn(), readyState: "live" } as unknown as MediaStreamTrack;
  const stream = {
    getTracks: () => [track],
    getVideoTracks: () => kind === "video" ? [track] : [],
  } as unknown as MediaStream;
  return { track, stream };
}

describe("canvas lifecycle and renderer", () => {
  it("creates one configured canvas, resizes safely, clears, and disposes idempotently", () => {
    const fixture = createFakeCanvasFixture();
    const manager = new CanvasManager(() => fixture.canvas);
    const surface = manager.create(TEST_RENDER_CONFIG);
    expect(surface.canvas.width).toBe(1280);
    expect(surface.canvas.height).toBe(720);
    expect(manager.getSurface()).toBe(surface);

    manager.resize(1920, 1080);
    expect(surface.canvas.width).toBe(1920);
    expect(surface.canvas.height).toBe(1080);
    expect(fixture.context.clearRect).toHaveBeenCalled();
    manager.dispose();
    manager.dispose();
    expect(surface.canvas.width).toBe(0);
    expect(surface.canvas.height).toBe(0);
    expect(() => manager.getSurface()).toThrowError(StreamEngineError);
    expect(() => manager.create(TEST_RENDER_CONFIG)).toThrowError(StreamEngineError);
  });

  it("reports an unavailable 2D context as a structured canvas error", () => {
    const canvas = { width: 0, height: 0, getContext: vi.fn(() => null) } as unknown as HTMLCanvasElement;
    const manager = new CanvasManager(() => canvas);
    expect(() => manager.create(TEST_RENDER_CONFIG)).toThrowError(expect.objectContaining({ streamCode: "CANVAS_CONTEXT_FAILED" }));
  });

  it("draws contain images centered with the requested output dimensions", () => {
    const fixture = createFakeCanvasFixture();
    const manager = new CanvasManager(() => fixture.canvas);
    manager.create({ ...TEST_RENDER_CONFIG, fitMode: "contain" });
    const renderer = new CanvasRenderer(manager, { ...TEST_RENDER_CONFIG, fitMode: "contain" });
    const source = createImageSource("med_fixture00000001", 1000, 500);
    renderer.setSource(source);

    expect(renderer.renderImage(source.element)).toBe(true);
    expect(fixture.context.drawImage).toHaveBeenCalledWith(
      source.element,
      0,
      0,
      1000,
      500,
      0,
      40,
      1280,
      640,
    );
    renderer.dispose();
    expect(() => renderer.render()).toThrowError(StreamEngineError);
    manager.dispose();
  });

  it("renders video frames with cover crop and resets transforms when mirrored", () => {
    const fixture = createFakeCanvasFixture();
    const manager = new CanvasManager(() => fixture.canvas);
    manager.create({ ...TEST_RENDER_CONFIG, mirror: true });
    const renderer = new CanvasRenderer(manager, { ...TEST_RENDER_CONFIG, mirror: true });
    const source = createVideoSource("med_fixture00000002", 1920, 1080);
    renderer.setSource(source);

    expect(renderer.renderVideo(source.element)).toBe(true);
    expect(fixture.context.drawImage).toHaveBeenCalledWith(
      source.element,
      0,
      0,
      1920,
      1080,
      0,
      0,
      1280,
      720,
    );
    expect(fixture.context.translate).toHaveBeenCalledWith(1280, 0);
    expect(fixture.context.scale).toHaveBeenCalledWith(-1, 1);
    expect(fixture.context.setTransform).toHaveBeenLastCalledWith(1, 0, 0, 1, 0, 0);
    manager.dispose();
  });

  it("does not draw undecoded images or video before a frame is ready", () => {
    const fixture = createFakeCanvasFixture();
    const manager = new CanvasManager(() => fixture.canvas);
    manager.create(TEST_RENDER_CONFIG);
    const renderer = new CanvasRenderer(manager, TEST_RENDER_CONFIG);
    const image = { complete: false, naturalWidth: 0, naturalHeight: 0 } as unknown as HTMLImageElement;
    renderer.setSource({ mediaId: "med_fixture00000003", kind: "image", width: 1, height: 1, element: image });
    expect(renderer.render()).toBe(false);

    const video = { readyState: 1, videoWidth: 0, videoHeight: 0 } as unknown as HTMLVideoElement;
    renderer.setSource({ mediaId: "med_fixture00000004", kind: "video", width: 1, height: 1, element: video });
    expect(renderer.render()).toBe(false);
    expect(fixture.context.drawImage).not.toHaveBeenCalled();
    manager.dispose();
  });
});

describe("single frame scheduler", () => {
  it("keeps one timer, avoids duplicate loops, and cancels on stop and dispose", () => {
    const clock = new FakeClock();
    const render = vi.fn();
    const scheduler = new FrameScheduler(render, 30, vi.fn(), clock);
    scheduler.start();
    scheduler.start();
    expect(clock.pendingCount).toBe(1);
    expect(scheduler.isRunning()).toBe(true);

    clock.runNext();
    expect(render).toHaveBeenCalledTimes(1);
    expect(clock.pendingCount).toBe(1);
    scheduler.stop();
    expect(clock.pendingCount).toBe(0);
    expect(scheduler.isRunning()).toBe(false);
    scheduler.dispose();
    expect(() => scheduler.start()).toThrowError(StreamEngineError);
  });

  it("stops safely and reports a rendering error without scheduling again", () => {
    const clock = new FakeClock();
    const error = new Error("draw failed");
    const onError = vi.fn();
    const scheduler = new FrameScheduler(() => { throw error; }, 30, onError, clock);
    scheduler.start();
    clock.runNext();
    expect(onError).toHaveBeenCalledWith(error);
    expect(scheduler.isRunning()).toBe(false);
    expect(clock.pendingCount).toBe(0);
  });

  it("surfaces timer allocation failures both at start and during the loop", () => {
    const initialClock = new FakeClock();
    initialClock.failure = new Error("timer blocked");
    const initialScheduler = new FrameScheduler(vi.fn(), 30, vi.fn(), initialClock);
    expect(() => initialScheduler.start()).toThrowError(expect.objectContaining({ streamCode: "FRAME_SCHEDULER_FAILED" }));
    expect(initialScheduler.isRunning()).toBe(false);

    const clock = new FakeClock();
    const onError = vi.fn();
    const scheduler = new FrameScheduler(vi.fn(), 30, onError, clock);
    scheduler.start();
    clock.failure = new Error("timer blocked later");
    clock.runNext();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ streamCode: "FRAME_SCHEDULER_FAILED" }));
    expect(scheduler.isRunning()).toBe(false);
    expect(clock.pendingCount).toBe(0);
  });
});

describe("canvas capture stream", () => {
  it("uses the requested FPS and requires exactly one video track", () => {
    const fixture = createFakeCanvasFixture();
    fixture.canvas.width = 1280;
    fixture.canvas.height = 720;
    const { stream } = fakeCaptureTrack();
    const capture = vi.fn(() => stream);
    const factory = new StreamFactory(capture);
    expect(factory.createFromCanvas(fixture.canvas, 60)).toBe(stream);
    expect(capture).toHaveBeenCalledWith(fixture.canvas, 60);
  });

  it("wraps native capture errors into structured stream failures", () => {
    const fixture = createFakeCanvasFixture();
    fixture.canvas.width = 1280;
    fixture.canvas.height = 720;
    const factory = new StreamFactory(() => { throw new Error("capture denied"); });
    expect(() => factory.createFromCanvas(fixture.canvas, 30))
      .toThrowError(expect.objectContaining({ streamCode: "STREAM_CAPTURE_FAILED" }));
  });

  it("rejects invalid dimensions, FPS, and captures without a video track", () => {
    const fixture = createFakeCanvasFixture();
    fixture.canvas.width = 1280;
    fixture.canvas.height = 720;
    const { stream, track } = fakeCaptureTrack("audio");
    const factory = new StreamFactory(() => stream);
    expect(() => factory.createFromCanvas(fixture.canvas, 30)).toThrowError(StreamEngineError);
    expect(track.stop).toHaveBeenCalledOnce();
    expect(() => new StreamFactory(() => stream).createFromCanvas(fixture.canvas, 0)).toThrowError(StreamEngineError);
    fixture.canvas.width = 0;
    expect(() => factory.createFromCanvas(fixture.canvas, 30)).toThrowError(StreamEngineError);
  });
});
