import { describe, expect, it, vi } from "vitest";
import type { MediaEngine } from "../../src/media/media-engine";
import { MediaRuntime } from "../../src/offscreen/media-runtime";
import { PlaybackEngine } from "../../src/playback/playback-engine";
import { createFakeVideoSource, FakePlaybackVideo } from "../playback/fakes";
import type { StreamManager } from "../../src/stream/stream-manager";

describe("MediaRuntime dependency cleanup", () => {
  it("shuts down in reverse dependency order and continues cleanup after a subsystem failure", async () => {
    const calls: string[] = [];
    const playback = {
      disposeAll: vi.fn(async () => { calls.push("playback"); throw new Error("playback cleanup failed"); }),
    } as unknown as PlaybackEngine;
    const streams = {
      disposeAll: vi.fn(async () => { calls.push("stream"); }),
    } as unknown as StreamManager;
    const mediaEngine = {
      initialize: vi.fn(async () => undefined),
      shutdown: vi.fn(async () => { calls.push("media"); }),
      list: vi.fn(() => []),
    } as unknown as MediaEngine;
    const runtime = new MediaRuntime(mediaEngine, streams, playback);
    await runtime.initialize();

    await expect(runtime.shutdown()).rejects.toMatchObject({ code: "CAPCAM_RUNTIME_ERROR" });
    expect(calls).toEqual(["playback", "stream", "media"]);
    expect(playback.disposeAll).toHaveBeenCalledOnce();
    expect(streams.disposeAll).toHaveBeenCalledOnce();
    expect(mediaEngine.shutdown).toHaveBeenCalledOnce();
    expect(runtime.getStatus()).toEqual({ status: "ERROR", initializedAt: null });
  });

  it("keeps runtime initialization idempotent and shutdown safe when repeated", async () => {
    const playback = { disposeAll: vi.fn(async () => undefined) } as unknown as PlaybackEngine;
    const streams = { disposeAll: vi.fn(async () => undefined) } as unknown as StreamManager;
    const mediaEngine = {
      initialize: vi.fn(async () => undefined),
      shutdown: vi.fn(async () => undefined),
      list: vi.fn(() => []),
    } as unknown as MediaEngine;
    const runtime = new MediaRuntime(mediaEngine, streams, playback);

    await runtime.initialize();
    await runtime.initialize();
    await runtime.shutdown();
    await runtime.shutdown();

    expect(mediaEngine.initialize).toHaveBeenCalledOnce();
    expect(mediaEngine.shutdown).toHaveBeenCalledOnce();
    expect(playback.disposeAll).toHaveBeenCalledOnce();
    expect(streams.disposeAll).toHaveBeenCalledOnce();
    expect(runtime.getStatus().status).toBe("STOPPED");
  });

  it("serializes media removal against playback loads so a removed source cannot be reattached", async () => {
    const mediaId = "med_source000001";
    let sourceRemoved = false;
    let releaseDisposal!: () => void;
    let signalDisposalStarted!: () => void;
    const disposalGate = new Promise<void>((resolve) => { releaseDisposal = resolve; });
    const disposalStarted = new Promise<void>((resolve) => { signalDisposalStarted = resolve; });
    const video = new FakePlaybackVideo();
    const playback = new PlaybackEngine({
      getRenderableSource: (requestedId) => {
        if (sourceRemoved || requestedId !== mediaId) throw new Error("The source is unavailable.");
        return createFakeVideoSource(mediaId, video);
      },
    });
    const idleStream = {
      streamId: null,
      sourceMediaId: null,
      state: "IDLE",
      config: null,
      track: null,
      error: null,
      disposed: false,
      changedAt: Date.now(),
    };
    const streams = {
      getState: () => idleStream,
      disposeForMedia: vi.fn(async () => {
        signalDisposalStarted();
        await disposalGate;
      }),
      disposeAll: vi.fn(async () => undefined),
    } as unknown as StreamManager;
    const mediaEngine = {
      remove: vi.fn(async (requestedId: string) => {
        sourceRemoved = true;
        return { id: requestedId };
      }),
    } as unknown as MediaEngine;
    const runtime = new MediaRuntime(mediaEngine, streams, playback);

    const removing = runtime.remove({ mediaId });
    await disposalStarted;
    const loading = runtime.loadPlayback({ mediaId });
    releaseDisposal();

    await removing;
    await expect(loading).rejects.toMatchObject({ playbackCode: "PLAYBACK_MEDIA_NOT_FOUND" });
    expect(playback.getActiveCount()).toBe(0);
    expect(video.listenerCount("ended")).toBe(0);
  });
});
