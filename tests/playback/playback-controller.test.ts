import { afterEach, describe, expect, it, vi } from "vitest";
import { PlaybackController } from "../../src/playback/playback-controller";
import type { PlaybackRecord } from "../../src/playback/playback-types";
import { createFakeImageSource, createFakeVideoSource, FakePlaybackVideo } from "./fakes";

function makeRecord(kind: "image" | "video", duration: number | null = null): PlaybackRecord {
  return {
    playbackId: "playback_test000001",
    mediaId: `med_${kind}source001`,
    kind,
    state: "LOADING",
    currentTime: 0,
    duration,
    playbackRate: 1,
    loop: false,
    startedAt: null,
    updatedAt: Date.now(),
    error: null,
  };
}

afterEach(() => vi.useRealTimers());

describe("image playback controller", () => {
  it("loads, presents at time zero, pauses, resumes, stops, and disposes without a video element", async () => {
    const source = createFakeImageSource("med_imagesource001");
    const publish = vi.fn();
    const controller = new PlaybackController(makeRecord("image"), source, publish);
    expect((await controller.load()).state).toBe("READY");
    expect((await controller.play()).state).toBe("PLAYING");
    expect(controller.getState().currentTime).toBe(0);
    expect(controller.pause().state).toBe("PAUSED");
    expect((await controller.play()).state).toBe("PLAYING");
    expect(controller.stop()).toMatchObject({ state: "STOPPED", currentTime: 0 });
    expect(controller.dispose().state).toBe("STOPPED");
    await expect(controller.play()).rejects.toMatchObject({ playbackCode: "PLAYBACK_DISPOSED" });
    expect(publish.mock.calls.map(([type]) => type)).toEqual([
      "playback.loaded", "playback.play", "playback.pause", "playback.play", "playback.stop",
    ]);
  });

  it("holds an image indefinitely by default and ends an optional-duration presentation", async () => {
    vi.useFakeTimers();
    const source = createFakeImageSource("med_imagesource002");
    const publish = vi.fn();
    const controller = new PlaybackController(makeRecord("image"), source, publish);
    await controller.load();
    await controller.play();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(controller.getState()).toMatchObject({ state: "PLAYING", currentTime: 0, duration: null });
    controller.dispose();

    const timed = new PlaybackController(makeRecord("image", 2), source, publish);
    await timed.load();
    await timed.play();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(timed.getState().state).toBe("PLAYING");
    await vi.advanceTimersByTimeAsync(1);
    expect(timed.getState()).toMatchObject({ state: "ENDED", currentTime: 0, duration: 2 });
    expect(publish.mock.calls.some(([type]) => type === "playback.ended")).toBe(true);
    timed.dispose();
  });

  it("loops timed image presentation and applies playback rate to its optional duration", async () => {
    vi.useFakeTimers();
    const source = createFakeImageSource("med_imagesource003");
    const publish = vi.fn();
    const looped = new PlaybackController(makeRecord("image", 1), source, publish);
    await looped.load();
    looped.setLoop(true);
    await looped.play();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(looped.getState()).toMatchObject({ state: "PLAYING", loop: true, currentTime: 0 });
    expect(publish.mock.calls.some(([type]) => type === "playback.loop")).toBe(true);
    looped.setLoop(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(looped.getState().state).toBe("ENDED");
    looped.dispose();

    const rated = new PlaybackController(makeRecord("image", 10), source, publish);
    await rated.load();
    await rated.play();
    await vi.advanceTimersByTimeAsync(2_000);
    rated.setPlaybackRate(2);
    await vi.advanceTimersByTimeAsync(3_999);
    expect(rated.getState().state).toBe("PLAYING");
    await vi.advanceTimersByTimeAsync(1);
    expect(rated.getState().state).toBe("ENDED");
    rated.dispose();
  });
});

describe("video playback controller", () => {
  it("plays, pauses, resumes, seeks with clamping, restarts, changes speed, and stops", async () => {
    const video = new FakePlaybackVideo();
    const source = createFakeVideoSource("med_videosource001", video);
    const publish = vi.fn();
    const controller = new PlaybackController(makeRecord("video", video.duration), source, publish);
    expect((await controller.load()).state).toBe("READY");
    expect(video.loop).toBe(false);

    expect((await controller.play()).state).toBe("PLAYING");
    video.currentTime = 4.5;
    video.dispatch("timeupdate");
    expect(controller.getState().currentTime).toBe(4.5);
    expect(controller.pause()).toMatchObject({ state: "PAUSED", currentTime: 4.5 });
    expect((await controller.play()).state).toBe("PLAYING");
    expect(video.currentTime).toBe(4.5);

    controller.seek(-5);
    expect(controller.getState().currentTime).toBe(0);
    controller.seek(999_999);
    expect(controller.getState().currentTime).toBe(video.duration);
    controller.seek(6);
    expect(controller.getState().currentTime).toBe(6);
    for (const rate of [0.5, 1, 1.5, 2]) controller.setPlaybackRate(rate);
    expect(controller.getState().playbackRate).toBe(2);
    await controller.restart();
    expect(controller.getState()).toMatchObject({ state: "PLAYING", currentTime: 0 });
    expect(controller.stop()).toMatchObject({ state: "STOPPED", currentTime: 0 });
    expect(video.paused).toBe(true);
    controller.dispose();
    expect(video.listenerCount("ended")).toBe(0);
    expect(video.listenerCount("timeupdate")).toBe(0);

    expect(() => controller.seek(Number.NaN)).toThrowError(expect.objectContaining({ playbackCode: "PLAYBACK_DISPOSED" }));
  });

  it("reports invalid seek/rate values as typed errors without corrupting state", async () => {
    const video = new FakePlaybackVideo();
    const controller = new PlaybackController(makeRecord("video", video.duration), createFakeVideoSource("med_videosource002", video), vi.fn());
    await controller.load();
    expect(() => controller.seek(Number.NaN)).toThrowError(expect.objectContaining({ playbackCode: "PLAYBACK_INVALID_TIME" }));
    expect(() => controller.seek(Number.POSITIVE_INFINITY)).toThrowError(expect.objectContaining({ playbackCode: "PLAYBACK_INVALID_TIME" }));
    for (const rate of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.1]) {
      expect(() => controller.setPlaybackRate(rate)).toThrowError(expect.objectContaining({ playbackCode: "PLAYBACK_INVALID_RATE" }));
    }
    expect(controller.getState().state).toBe("READY");
    controller.dispose();
  });

  it("restarts on ended when looping and otherwise transitions to ENDED without destroying its source", async () => {
    const video = new FakePlaybackVideo();
    const publish = vi.fn();
    const controller = new PlaybackController(makeRecord("video", video.duration), createFakeVideoSource("med_videosource003", video), publish);
    await controller.load();
    await controller.play();
    video.end();
    expect(controller.getState()).toMatchObject({ state: "ENDED", currentTime: video.duration });
    expect(video.listenerCount("ended")).toBe(1);
    await controller.play();
    expect(controller.getState().state).toBe("PLAYING");
    controller.setLoop(true);
    video.end();
    await Promise.resolve();
    expect(controller.getState()).toMatchObject({ state: "PLAYING", loop: true, currentTime: 0 });
    expect(video.paused).toBe(false);
    expect(publish.mock.calls.some(([type]) => type === "playback.loop")).toBe(true);
    controller.dispose();
  });

  it("waits for metadata and applies a pending seek before declaring the source ready", async () => {
    const video = new FakePlaybackVideo();
    video.readyState = 0;
    video.currentTime = 0;
    const source = createFakeVideoSource("med_videosource004", video);
    const controller = new PlaybackController(makeRecord("video", null), source, vi.fn(), { metadataTimeoutMs: 1_000 });
    const loading = controller.load();
    controller.seek(5);
    video.readyState = 1;
    video.dispatch("loadedmetadata");
    await expect(loading).resolves.toMatchObject({ state: "READY", currentTime: 5, duration: video.duration });
    expect(video.currentTime).toBe(5);
    controller.dispose();
  });

  it("converts autoplay rejection into a playback error state", async () => {
    const video = new FakePlaybackVideo();
    video.playFailure = new Error("autoplay denied");
    const controller = new PlaybackController(makeRecord("video", video.duration), createFakeVideoSource("med_videosource005", video), vi.fn());
    await controller.load();
    await expect(controller.play()).rejects.toMatchObject({ playbackCode: "PLAYBACK_PLAY_FAILED" });
    expect(controller.getState()).toMatchObject({ state: "ERROR", error: { code: "PLAYBACK_PLAY_FAILED" } });
    controller.dispose();
  });
});
