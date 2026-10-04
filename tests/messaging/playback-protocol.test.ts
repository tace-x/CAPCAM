import { describe, expect, it } from "vitest";
import { createCommand } from "../../src/messaging/commands";
import { createEvent } from "../../src/messaging/events";
import { CommandRouter } from "../../src/messaging/router";
import { isEventEnvelope, validateCommand } from "../../src/messaging/protocol";
import type { PlaybackRecord } from "../../src/playback/playback-types";

const record: PlaybackRecord = {
  playbackId: "playback_fixture0001",
  mediaId: "med_fixture0001",
  kind: "video",
  state: "READY",
  currentTime: 0,
  duration: 20,
  playbackRate: 1,
  loop: false,
  startedAt: null,
  updatedAt: 100,
  error: null,
};

describe("typed playback protocol", () => {
  it("validates typed playback commands and passes numeric edge cases to structured engine validation", () => {
    expect(validateCommand(createCommand("playback.load", { mediaId: "med_fixture0001" })).ok).toBe(true);
    expect(validateCommand(createCommand("playback.seek", { playbackId: record.playbackId, time: Number.NaN })).ok).toBe(true);
    expect(validateCommand(createCommand("playback.setRate", { playbackId: record.playbackId, rate: Number.POSITIVE_INFINITY })).ok).toBe(true);
    expect(validateCommand(createCommand("playback.setLoop", { playbackId: record.playbackId, enabled: true })).ok).toBe(true);
    expect(validateCommand({ ...createCommand("playback.play", { playbackId: record.playbackId }), payload: { playbackId: record.playbackId, video: {} } }).ok).toBe(false);
    expect(validateCommand(createCommand("playback.dispose", { playbackId: "bad-id" })).ok).toBe(false);
  });

  it("validates serializable playback events and record snapshots", () => {
    const event = createEvent("playback.loaded", {
      playbackId: record.playbackId,
      mediaId: record.mediaId,
      timestamp: 101,
      record,
    });
    expect(isEventEnvelope(event)).toBe(true);
    expect(isEventEnvelope({ ...event, payload: { ...event.payload, mediaId: "med_other00001" } })).toBe(false);
    expect(isEventEnvelope({ ...event, payload: { ...event.payload, record: { ...record, currentTime: Infinity } } })).toBe(false);
  });

  it("routes playback state without transporting media elements", async () => {
    const router = new CommandRouter();
    router.register("playback.getState", () => record);
    const response = await router.handle(createCommand("playback.getState"));
    expect(response.success).toBe(true);
    if (response.success) expect(response.data).toEqual(record);
  });
});
