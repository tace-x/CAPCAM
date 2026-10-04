import { describe, expect, it, vi } from "vitest";
import { CanvasManager } from "../../src/canvas/canvas-manager";
import type { MediaEngine } from "../../src/media/media-engine";
import { MediaRuntime } from "../../src/offscreen/media-runtime";
import { RuntimeManager } from "../../src/offscreen/runtime-manager";
import { PlaybackEngine } from "../../src/playback/playback-engine";
import { CanvasStreamPipelineFactory } from "../../src/stream/canvas-stream-pipeline";
import { StreamManager } from "../../src/stream/stream-manager";
import type { RenderConfig } from "../../src/canvas/render-types";
import { createFakeCanvasFixture, FakeScheduler, FakeStreamFactory, TEST_RENDER_CONFIG } from "../stream/fakes";
import { FakePlaybackSourceProvider, FakePlaybackVideo, createFakeImageSource, createFakeVideoSource } from "../playback/fakes";

const TEST_CONFIG: RenderConfig = TEST_RENDER_CONFIG;

describe("Phase 05 managed offscreen media pipeline", () => {
  it("coordinates playback and an existing canvas stream under runtime lifecycle ownership", async () => {
    const provider = new FakePlaybackSourceProvider();
    const video = new FakePlaybackVideo();
    provider.add(createFakeVideoSource("med_videoalpha001", video));
    provider.add(createFakeImageSource("med_imagealpha001"));

    const canvas = createFakeCanvasFixture();
    const streamFactory = new FakeStreamFactory();
    const schedulers: FakeScheduler[] = [];
    const pipelineFactory = new CanvasStreamPipelineFactory(provider, {
      createCanvasManager: () => new CanvasManager(() => canvas.canvas),
      streamFactory,
      createScheduler: (render, _fps, onError) => {
        const scheduler = new FakeScheduler(render, onError);
        schedulers.push(scheduler);
        return scheduler;
      },
    });
    const streams = new StreamManager(pipelineFactory, { createStreamId: () => "stream_runtimepipe0001" });
    let playbackSequence = 0;
    const playback = new PlaybackEngine(provider, {
      createPlaybackId: () => {
        playbackSequence += 1;
        return `playback_runtimepipe${String(playbackSequence).padStart(4, "0")}`;
      },
    });
    const mediaEngine = {
      initialize: vi.fn(async () => undefined),
      shutdown: vi.fn(async () => undefined),
      list: vi.fn(() => []),
      getRenderableSource: provider.getRenderableSource.bind(provider),
    } as unknown as MediaEngine;
    const mediaRuntime = new MediaRuntime(mediaEngine, streams, playback);
    const runtime = new RuntimeManager(mediaRuntime);

    expect((await runtime.initialize()).state).toBe("ready");
    const created = await runtime.runSubsystemOperation(() => mediaRuntime.createStream({
      mediaId: "med_videoalpha001",
      config: TEST_CONFIG,
    }));
    expect(created.state).toBe("READY");
    expect(runtime.getState().state).toBe("ready");

    const started = await runtime.runSubsystemOperation(() => mediaRuntime.startStream({ streamId: created.streamId! }));
    expect(started.state).toBe("ACTIVE");
    expect(runtime.getState().state).toBe("active");
    const originalStream = streams.getStream();
    const originalTrack = streams.getTrack();
    const playbackRecord = mediaRuntime.getPlaybackState();
    expect(playbackRecord?.state).toBe("READY");

    await runtime.runSubsystemOperation(() => mediaRuntime.playPlayback({ playbackId: playbackRecord!.playbackId }));
    expect(runtime.getDiagnostics()).toMatchObject({
      state: "active",
      activePlaybackCount: 1,
      activeStreamCount: 1,
      rendererActive: true,
    });
    video.end();
    runtime.observeSubsystemActivity();
    await Promise.resolve();
    await Promise.resolve();
    expect(mediaRuntime.getPlaybackState()?.state).toBe("ENDED");
    expect(runtime.getState().state).toBe("active");
    expect(streams.getState().state).toBe("ACTIVE");
    expect(streams.getStream()).toBe(originalStream);
    expect(streams.getTrack()).toBe(originalTrack);
    expect(originalTrack.readyState).toBe("live");
    expect(schedulers[0]?.isRunning()).toBe(true);

    const switched = await runtime.runSubsystemOperation(() => mediaRuntime.loadPlayback({ mediaId: "med_imagealpha001" }));
    expect(switched).toMatchObject({ kind: "image", state: "READY", currentTime: 0 });
    expect(streams.getState()).toMatchObject({ state: "ACTIVE", sourceMediaId: "med_imagealpha001" });
    expect(streams.getStream()).toBe(originalStream);
    expect(streams.getTrack()).toBe(originalTrack);
    expect(streamFactory.createFromCanvas).toHaveBeenCalledOnce();
    expect(schedulers).toHaveLength(1);
    expect(video.listenerCount("ended")).toBe(0);

    const stopped = await runtime.runSubsystemOperation(() => mediaRuntime.stopStream({ streamId: created.streamId! }));
    expect(stopped.state).toBe("STOPPED");
    expect(runtime.getState().state).toBe("ready");
    expect(originalTrack.readyState).toBe("ended");

    expect((await runtime.shutdown()).state).toBe("stopped");
    expect(streams.getState().disposed).toBe(true);
    expect(canvas.canvas.width).toBe(0);
    expect(canvas.canvas.height).toBe(0);
    expect(mediaEngine.shutdown).toHaveBeenCalledOnce();
    expect(runtime.getDiagnostics()).toMatchObject({
      state: "stopped",
      activePlaybackCount: 0,
      activeStreamCount: 0,
      rendererActive: false,
    });
  });
});
