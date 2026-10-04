import { describe, expect, it, vi } from "vitest";
import { CanvasManager } from "../../src/canvas/canvas-manager";
import { CanvasStreamPipelineFactory } from "../../src/stream/canvas-stream-pipeline";
import { StreamEngineError } from "../../src/stream/stream-errors";
import { StreamManager } from "../../src/stream/stream-manager";
import type { StreamPipelineFactory } from "../../src/stream/stream-types";
import { isStreamId, isStreamInfo } from "../../src/stream/stream-types";
import {
  createFakeCanvasFixture,
  createImageSource,
  createVideoSource,
  FakeScheduler,
  FakeSourceProvider,
  FakeStreamFactory,
  TEST_RENDER_CONFIG,
} from "./fakes";

function createHarness(options: {
  onFrameError?: (error: unknown) => void;
  createStreamId?: () => string;
} = {}) {
  const canvas = createFakeCanvasFixture();
  const provider = new FakeSourceProvider();
  provider.add(createImageSource("med_source000001", 640, 480));
  provider.add(createVideoSource("med_source000002", 1920, 1080));
  const streamFactory = new FakeStreamFactory();
  const schedulers: FakeScheduler[] = [];
  const factory = new CanvasStreamPipelineFactory(provider, {
    createCanvasManager: () => new CanvasManager(() => canvas.canvas),
    streamFactory,
    createScheduler: (render, _fps, onError) => {
      const scheduler = new FakeScheduler(render, options.onFrameError ?? onError);
      schedulers.push(scheduler);
      return scheduler;
    },
  });
  let nextId = 0;
  const manager = new StreamManager(factory, {
    createStreamId: options.createStreamId ?? (() => {
      nextId += 1;
      return `stream_test${String(nextId).padStart(4, "0")}`;
    }),
  });
  return { manager, provider, streamFactory, schedulers, canvas };
}

describe("offscreen canvas stream lifecycle", () => {
  it("creates, starts, stops, restarts, switches, and disposes without duplicate schedulers", async () => {
    const { manager, provider, streamFactory, schedulers, canvas } = createHarness();
    const created = await manager.create({ mediaId: "med_source000001", config: TEST_RENDER_CONFIG });
    expect(created.state).toBe("READY");
    expect(created.streamId).toBe("stream_test0001-1");
    expect(created.track?.kind).toBe("video");
    expect(created.track?.readyState).toBe("live");
    expect(streamFactory.createFromCanvas).toHaveBeenCalledOnce();
    expect(isStreamInfo(created)).toBe(true);

    const started = await manager.start({ streamId: created.streamId! });
    expect(started.state).toBe("ACTIVE");
    expect(schedulers[0]?.running).toBe(true);
    await expect(manager.start({ streamId: created.streamId! })).rejects.toMatchObject({ streamCode: "STREAM_ALREADY_ACTIVE" });

    const stopped = await manager.stop({ streamId: created.streamId! });
    expect(stopped.state).toBe("STOPPED");
    expect(stopped.track?.readyState).toBe("ended");
    expect(schedulers[0]?.running).toBe(false);
    expect(streamFactory.tracks[0]?.readyState).toBe("ended");

    const resumed = await manager.start({ streamId: created.streamId! });
    expect(resumed.state).toBe("ACTIVE");
    expect(streamFactory.createFromCanvas).toHaveBeenCalledTimes(2);
    expect(streamFactory.tracks[1]?.readyState).toBe("live");

    const switched = await manager.switchSource({ streamId: created.streamId!, mediaId: "med_source000002" });
    expect(switched.sourceMediaId).toBe("med_source000002");
    expect(provider.playCalls).toEqual([]);
    expect(provider.pauseCalls).toEqual([]);

    const restarted = await manager.restart({ streamId: created.streamId! });
    expect(restarted.state).toBe("ACTIVE");
    expect(streamFactory.createFromCanvas).toHaveBeenCalledTimes(3);
    expect(provider.pauseCalls).toEqual([]);
    expect(schedulers[0]?.startCalls).toBe(3);

    const disposed = await manager.dispose({ streamId: created.streamId! });
    expect(disposed.state).toBe("STOPPED");
    expect(disposed.disposed).toBe(true);
    expect(disposed.track?.readyState).toBe("ended");
    expect(isStreamInfo(disposed)).toBe(true);
    expect(schedulers[0]?.disposed).toBe(true);
    expect(canvas.canvas.width).toBe(0);
    expect(() => manager.getStream()).toThrowError(StreamEngineError);

    const next = await manager.create({ mediaId: "med_source000001", config: TEST_RENDER_CONFIG });
    expect(next.streamId).toBe("stream_test0002-2");
    expect(next.state).toBe("READY");
  });

  it("does not accumulate tracks, render loops, or canvas resources across repeated create/stop/dispose cycles", async () => {
    const { manager, streamFactory, schedulers, canvas } = createHarness();
    const iterations = 5;

    for (let index = 0; index < iterations; index += 1) {
      const created = await manager.create({ mediaId: "med_source000001", config: TEST_RENDER_CONFIG });
      await manager.start({ streamId: created.streamId! });
      await manager.stop({ streamId: created.streamId! });
      const disposed = await manager.dispose({ streamId: created.streamId! });
      expect(disposed.disposed).toBe(true);
      expect(canvas.canvas.width).toBe(0);
      expect(canvas.canvas.height).toBe(0);
    }

    expect(streamFactory.createFromCanvas).toHaveBeenCalledTimes(iterations);
    expect(streamFactory.tracks).toHaveLength(iterations);
    expect(streamFactory.tracks.every((track) => track.readyState === "ended")).toBe(true);
    expect(schedulers).toHaveLength(iterations);
    expect(schedulers.every((scheduler) => scheduler.disposed && !scheduler.isRunning())).toBe(true);
    expect(manager.getActiveCount()).toBe(0);
  });

  it("keeps stream IDs unique across repeated create/dispose cycles when the generator repeats", async () => {
    const { manager } = createHarness({ createStreamId: () => "stream_test0001" });
    const streamIds: string[] = [];

    for (let index = 0; index < 16; index += 1) {
      const created = await manager.create({ mediaId: "med_source000001", config: TEST_RENDER_CONFIG });
      streamIds.push(created.streamId!);
      await manager.dispose({ streamId: created.streamId! });
    }

    expect(new Set(streamIds).size).toBe(streamIds.length);
    expect(streamIds.every(isStreamId)).toBe(true);
    await expect(manager.start({ streamId: streamIds[0]! })).rejects.toMatchObject({ streamCode: "STREAM_NOT_FOUND" });
  });

  it("serializes concurrent lifecycle commands so duplicate starts cannot stop the active stream", async () => {
    const { manager, streamFactory } = createHarness();
    const created = await manager.create({ mediaId: "med_source000001", config: TEST_RENDER_CONFIG });
    const outcomes = await Promise.allSettled([
      manager.start({ streamId: created.streamId! }),
      manager.start({ streamId: created.streamId! }),
    ]);
    expect(outcomes[0]?.status).toBe("fulfilled");
    expect(outcomes[1]).toMatchObject({ status: "rejected", reason: { streamCode: "STREAM_ALREADY_ACTIVE" } });
    expect(manager.getState().state).toBe("ACTIVE");
    expect(streamFactory.tracks[0]?.readyState).toBe("live");
  });

  it("waits for creation before disposing when lifecycle commands overlap", async () => {
    const { manager } = createHarness();
    const creating = manager.create({ mediaId: "med_source000001", config: TEST_RENDER_CONFIG });
    const disposing = manager.dispose();
    const [created, disposed] = await Promise.all([creating, disposing]);
    expect(created.state).toBe("READY");
    expect(disposed.state).toBe("STOPPED");
    expect(disposed.disposed).toBe(true);
    expect(disposed.streamId).toBe(created.streamId);
  });

  it("switches sources while active and leaves the original pipeline intact when a source is unavailable", async () => {
    const { manager, provider } = createHarness();
    const created = await manager.create({ mediaId: "med_source000001", config: TEST_RENDER_CONFIG });
    await manager.start({ streamId: created.streamId! });

    await expect(manager.switchSource({ streamId: created.streamId!, mediaId: "med_missing0001" }))
      .rejects.toMatchObject({ streamCode: "STREAM_SOURCE_UNAVAILABLE" });
    expect(manager.getState().state).toBe("ACTIVE");
    expect(manager.getState().sourceMediaId).toBe("med_source000001");
    expect(provider.pauseCalls).toHaveLength(0);
  });

  it("serializes initialization and runtime errors while preserving recoverable state", async () => {
    const factory: StreamPipelineFactory = {
      create: async () => { throw new StreamEngineError("STREAM_CAPTURE_FAILED", "capture not supported"); },
    };
    const manager = new StreamManager(factory, { createStreamId: () => "stream_failure0001" });
    await expect(manager.create({ mediaId: "med_source000001", config: TEST_RENDER_CONFIG }))
      .rejects.toMatchObject({ streamCode: "STREAM_CAPTURE_FAILED" });
    const failed = manager.getState();
    expect(failed.state).toBe("ERROR");
    expect(failed.error?.code).toBe("STREAM_CAPTURE_FAILED");
    expect(failed.error?.message).toBe("capture not supported");
    expect(failed.disposed).toBe(true);
    expect(isStreamInfo(failed)).toBe(true);
  });

  it("rejects invalid configs without creating a stream", async () => {
    const { manager, streamFactory } = createHarness();
    await expect(manager.create({
      mediaId: "med_source000001",
      config: { ...TEST_RENDER_CONFIG, fps: 120 },
    })).rejects.toMatchObject({ streamCode: "STREAM_INVALID_CONFIG" });
    expect(manager.getState().state).toBe("IDLE");
    expect(streamFactory.createFromCanvas).not.toHaveBeenCalled();
  });

  it("moves to ERROR and stops tracks when the controlled render loop fails", async () => {
    const { manager, schedulers, streamFactory, canvas } = createHarness();
    const created = await manager.create({ mediaId: "med_source000001", config: TEST_RENDER_CONFIG });
    await manager.start({ streamId: created.streamId! });
    canvas.context.drawImage = vi.fn(() => { throw new Error("canvas failure"); }) as unknown as CanvasRenderingContext2D["drawImage"];

    schedulers[0]?.render();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(manager.getState().state).toBe("ERROR");
    expect(manager.getState().error?.code).toBe("STREAM_RENDER_FAILED");
    expect(streamFactory.tracks[0]?.readyState).toBe("ended");
  });
});
