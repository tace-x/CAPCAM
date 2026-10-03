import { describe, expect, it } from "vitest";
import { createCommand } from "../../src/messaging/commands";
import { createEvent } from "../../src/messaging/events";
import { CommandRouter } from "../../src/messaging/router";
import { isEventEnvelope, validateCommand } from "../../src/messaging/protocol";
import type { StreamInfo } from "../../src/stream/stream-types";

const streamInfo: StreamInfo = {
  streamId: "stream_fixture0001",
  sourceMediaId: "med_fixture0001",
  state: "READY",
  config: { width: 1280, height: 720, fps: 30, fitMode: "cover", mirror: false },
  track: {
    id: "track-local",
    label: "CapCam canvas capture",
    kind: "video",
    readyState: "live",
    enabled: true,
    muted: false,
    settings: { width: 1280, height: 720, frameRate: 30, aspectRatio: 16 / 9 },
  },
  error: null,
  disposed: false,
  changedAt: 100,
};

describe("typed stream protocol", () => {
  it("accepts valid stream commands and rejects malformed IDs/configs/fields", () => {
    expect(validateCommand(createCommand("stream.create", {
      mediaId: "med_fixture0001",
      config: { width: 1920, height: 1080, fps: 60, fitMode: "contain", mirror: true },
    })).ok).toBe(true);
    expect(validateCommand(createCommand("stream.getState")).ok).toBe(true);
    expect(validateCommand(createCommand("stream.start", { streamId: "stream_fixture0001" })).ok).toBe(true);

    const badConfig = createCommand("stream.create", {
      mediaId: "med_fixture0001",
      config: { width: 1280, height: 720, fps: 120, fitMode: "cover", mirror: false },
    });
    expect(validateCommand(badConfig).ok).toBe(false);
    expect(validateCommand(createCommand("stream.stop", { streamId: "not-a-stream" })).ok).toBe(false);
    expect(validateCommand({ ...createCommand("stream.getState"), payload: { mediaStream: {} } }).ok).toBe(false);
  });

  it("validates serializable stream snapshots and lifecycle events", () => {
    const event = createEvent("stream.stateChanged", streamInfo);
    expect(isEventEnvelope(event)).toBe(true);
    expect(isEventEnvelope({ ...event, payload: { ...streamInfo, track: { ...streamInfo.track, settings: { width: 0 } } } })).toBe(false);
  });

  it("routes typed stream responses without transporting stream objects", async () => {
    const router = new CommandRouter();
    router.register("stream.getState", () => streamInfo);
    const response = await router.handle(createCommand("stream.getState"));
    expect(response.success).toBe(true);
    if (response.success) expect(response.data).toEqual(streamInfo);
  });
});
