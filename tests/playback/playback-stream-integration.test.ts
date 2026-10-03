import { describe, expect, it, vi } from "vitest";
import { CanvasManager } from "../../src/canvas/canvas-manager";
import { MediaRuntime } from "../../src/offscreen/media-runtime";
import type { MediaEngine } from "../../src/media/media-engine";
import { CanvasStreamPipelineFactory } from "../../src/stream/canvas-stream-pipeline";
import { StreamManager } from "../../src/stream/stream-manager";
import type { RenderConfig } from "../../src/canvas/render-types";
import { createFakeCanvasFixture, FakeScheduler, FakeStreamFactory, TEST_RENDER_CONFIG } from "../stream/fakes";
import { FakePlaybackSourceProvider, FakePlaybackVideo, createFakeImageSource, createFakeVideoSource } from "./fakes";

const TEST_CONFIG: RenderConfig = TEST_RENDER_CONFIG;

describe("Phase 02 → playback → Phase 03 stream integration", () => {
  it("keeps the existing MediaStream active when non-looping video playback ends", async () => {
    const provider = new FakePlaybackSourceProvider();
    const video = new FakePlaybackVideo();
    provider.add(createFakeVideoSource("med_videoalpha001", video));
    provider.add(createFakeImageSource("med_imagealpha001"));
    const canvasFixture = createFakeCanvasFixture();
    const streamFactory = new FakeStreamFactory();
    const scheduler: { current: FakeScheduler | null } = { current: null };
    const pipelineFactory = new CanvasStreamPipelineFactory(provider, {
      createCanvasManager: () => new CanvasManager(() => canvasFixture.canvas),
      streamFactory,
      createScheduler: (render, _fps, onError) => {
        scheduler.current = new FakeScheduler(render, onError);
        return scheduler.current;
      },
    });
    const streams = new StreamManager(pipelineFactory, { createStreamId: () => "stream_integration0001" });
    const fakeMediaEngine = {
      getRenderableSource: provider.getRenderableSource.bind(provider),
      initialize: vi.fn(async () => undefined),
      shutdown: vi.fn(async () => undefined),
    } as unknown as MediaEngine;
    const runtime = new MediaRuntime(fakeMediaEngine, streams);

    const created = await runtime.createStream({ mediaId: "med_videoalpha001", config: TEST_CONFIG });
    expect(runtime.getPlaybackState()).toMatchObject({ state: "READY", mediaId: "med_videoalpha001" });
    const started = await runtime.startStream({ streamId: created.streamId! });
    const streamBeforePlayback = streams.getStream();
    const trackBeforePlayback = streams.getTrack();
    await runtime.playPlayback({ playbackId: runtime.getPlaybackState()!.playbackId });
    expect(video.paused).toBe(false);
    expect(streams.getState().state).toBe("ACTIVE");

    video.end();
    expect(runtime.getPlaybackState()?.state).toBe("ENDED");
    expect(streams.getState().state).toBe("ACTIVE");
    expect(streams.getStream()).toBe(streamBeforePlayback);
    expect(streams.getTrack()).toBe(trackBeforePlayback);
    expect(trackBeforePlayback.readyState).toBe("live");
    expect(scheduler.current?.isRunning()).toBe(true);
    scheduler.current?.render();
    expect(canvasFixture.context.drawImage).toHaveBeenCalled();
    expect(streamFactory.createFromCanvas).toHaveBeenCalledOnce();

    const imagePlayback = await runtime.loadPlayback({ mediaId: "med_imagealpha001" });
    expect(imagePlayback).toMatchObject({ kind: "image", state: "READY", currentTime: 0 });
    expect(streams.getState()).toMatchObject({ state: "ACTIVE", sourceMediaId: "med_imagealpha001" });
    expect(streams.getStream()).toBe(streamBeforePlayback);
    expect(streams.getTrack()).toBe(trackBeforePlayback);
    expect(scheduler.current?.isRunning()).toBe(true);
    expect(streamFactory.createFromCanvas).toHaveBeenCalledOnce();

    await runtime.shutdown();
    expect(streams.getState().disposed).toBe(true);
    expect(started.state).toBe("ACTIVE");
  });
});
