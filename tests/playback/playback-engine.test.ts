import { describe, expect, it } from "vitest";
import { PlaybackEngine } from "../../src/playback/playback-engine";
import { FakePlaybackSourceProvider, createFakeImageSource, createFakeVideoSource, FakePlaybackVideo } from "./fakes";

function createEngine() {
  const provider = new FakePlaybackSourceProvider();
  const firstVideo = new FakePlaybackVideo();
  const secondVideo = new FakePlaybackVideo();
  provider.add(createFakeVideoSource("med_videoalpha001", firstVideo));
  provider.add(createFakeVideoSource("med_videobeta0001", secondVideo));
  provider.add(createFakeImageSource("med_imagealpha001"));
  let nextId = 0;
  const events: Array<{ type: string; payload: { record: { mediaId: string; state: string } } }> = [];
  const engine = new PlaybackEngine(provider, {
    createPlaybackId: () => {
      nextId += 1;
      return `playback_fixture${String(nextId).padStart(4, "0")}`;
    },
    publishEvent: (event) => events.push(event as typeof events[number]),
  });
  return { engine, provider, firstVideo, secondVideo, events };
}

describe("offscreen playback engine", () => {
  it("loads a source, controls playback, tracks native events, and disposes by playback ID", async () => {
    const { engine, firstVideo, events } = createEngine();
    const ready = await engine.load({ mediaId: "med_videoalpha001" });
    expect(ready).toMatchObject({ state: "READY", kind: "video", currentTime: 0, duration: 12, playbackRate: 1, loop: false });
    expect((await engine.play({ playbackId: ready.playbackId })).state).toBe("PLAYING");
    firstVideo.currentTime = 3;
    firstVideo.dispatch("timeupdate");
    expect(engine.getState()?.currentTime).toBe(3);
    expect((await engine.pause({ playbackId: ready.playbackId })).state).toBe("PAUSED");
    expect((await engine.play({ playbackId: ready.playbackId })).state).toBe("PLAYING");
    expect((await engine.stop({ playbackId: ready.playbackId }))).toMatchObject({ state: "STOPPED", currentTime: 0 });
    expect((await engine.restart({ playbackId: ready.playbackId })).state).toBe("PLAYING");
    expect(events.map((event) => event.type)).toContain("playback.timeupdate");
    expect(await engine.dispose({ playbackId: ready.playbackId })).toBeNull();
    expect(engine.getState()).toBeNull();
    expect(firstVideo.listenerCount("ended")).toBe(0);
    await expect(engine.play({ playbackId: ready.playbackId })).rejects.toMatchObject({ playbackCode: "PLAYBACK_NOT_FOUND" });
  });

  it("switches video A to video B to image without stale listeners or old playback", async () => {
    const { engine, firstVideo, secondVideo, events } = createEngine();
    const first = await engine.load({ mediaId: "med_videoalpha001" });
    await engine.play({ playbackId: first.playbackId });
    expect(firstVideo.paused).toBe(false);
    expect(firstVideo.listenerCount("ended")).toBe(1);

    const second = await engine.load({ mediaId: "med_videobeta0001" });
    expect(second.playbackId).not.toBe(first.playbackId);
    expect(second).toMatchObject({ mediaId: "med_videobeta0001", state: "READY", currentTime: 0 });
    expect(firstVideo.paused).toBe(true);
    expect(firstVideo.listenerCount("ended")).toBe(0);
    firstVideo.end(); // A queued stale event must not mutate B.
    expect(engine.getState()?.mediaId).toBe("med_videobeta0001");

    const image = await engine.load({ mediaId: "med_imagealpha001" });
    expect(image).toMatchObject({ kind: "image", state: "READY", currentTime: 0, duration: null });
    expect(secondVideo.paused).toBe(true);
    expect(secondVideo.listenerCount("ended")).toBe(0);
    expect(events.some((event) => event.type === "playback.disposed" && event.payload.record.mediaId === "med_videoalpha001")).toBe(true);
    expect((await engine.play({ playbackId: image.playbackId })).state).toBe("PLAYING");
    await engine.disposeAll();
    expect(engine.getState()).toBeNull();
  });

  it("returns a structured error record for missing media and permits a later successful load", async () => {
    const { engine } = createEngine();
    await expect(engine.load({ mediaId: "med_missing00001" })).rejects.toMatchObject({
      code: "CAPCAM_PLAYBACK_ERROR",
      playbackCode: "PLAYBACK_MEDIA_NOT_FOUND",
    });
    expect(engine.getState()).toMatchObject({ state: "ERROR", kind: null, error: { code: "PLAYBACK_MEDIA_NOT_FOUND" } });
    const loaded = await engine.load({ mediaId: "med_imagealpha001" });
    expect(loaded.state).toBe("READY");
  });

  it("keeps same-source load idempotent and serializes overlapping control commands", async () => {
    const { engine, firstVideo } = createEngine();
    const loaded = await engine.load({ mediaId: "med_videoalpha001" });
    const same = await engine.load({ mediaId: "med_videoalpha001" });
    expect(same.playbackId).toBe(loaded.playbackId);
    const outcomes = await Promise.allSettled([
      engine.play({ playbackId: loaded.playbackId }),
      engine.play({ playbackId: loaded.playbackId }),
    ]);
    expect(outcomes[0]?.status).toBe("fulfilled");
    expect(outcomes[1]?.status).toBe("fulfilled");
    expect(engine.getState()?.state).toBe("PLAYING");
    expect(firstVideo.play).toHaveBeenCalledTimes(1);
  });

  it("validates optional image duration before replacing an existing source", async () => {
    const { engine } = createEngine();
    const loaded = await engine.load({ mediaId: "med_imagealpha001" });
    await expect(engine.load({ mediaId: "med_imagealpha001", imageDurationSeconds: Number.NaN }))
      .rejects.toMatchObject({ playbackCode: "PLAYBACK_INVALID_TIME" });
    expect(engine.getState()?.playbackId).toBe(loaded.playbackId);
  });
});
