import { describe, expect, it } from "vitest";
import { canTransitionPlaybackState, transitionPlaybackState } from "../../src/playback/playback-state";

describe("playback state machine", () => {
  it("allows the documented ready, play, pause, resume, end, stop, and reload paths", () => {
    expect(transitionPlaybackState("IDLE", "LOADING")).toBe("LOADING");
    expect(transitionPlaybackState("LOADING", "READY")).toBe("READY");
    expect(transitionPlaybackState("READY", "PLAYING")).toBe("PLAYING");
    expect(transitionPlaybackState("PLAYING", "PAUSED")).toBe("PAUSED");
    expect(transitionPlaybackState("PAUSED", "PLAYING")).toBe("PLAYING");
    expect(transitionPlaybackState("PLAYING", "ENDED")).toBe("ENDED");
    expect(transitionPlaybackState("PLAYING", "STOPPED")).toBe("STOPPED");
    expect(canTransitionPlaybackState("STOPPED", "LOADING")).toBe(true);
  });

  it("rejects invalid transitions with a structured playback state error", () => {
    expect(canTransitionPlaybackState("IDLE", "PLAYING")).toBe(false);
    expect(() => transitionPlaybackState("READY", "IDLE")).toThrowError(expect.objectContaining({
      code: "CAPCAM_PLAYBACK_ERROR",
      playbackCode: "PLAYBACK_INVALID_STATE",
    }));
  });
});
