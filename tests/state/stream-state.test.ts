import { describe, expect, it } from "vitest";
import { CapCamError } from "../../src/shared/errors";
import { createInitialCapCamState } from "../../src/shared/state";
import { canTransitionStreamState, transitionStreamState } from "../../src/stream/stream-state";

describe("central and stream state", () => {
  it("creates the typed initial CapCam state", () => {
    const state = createInitialCapCamState();
    expect(state.runtime.status).toBe("STARTING");
    expect(state.offscreen.status).toBe("STOPPED");
    expect(state.media.activeMediaId).toBeNull();
    expect(state.stream.status).toBe("IDLE");
    expect(state.settings.fps).toBe(30);
  });

  it("allows valid stream lifecycle transitions", () => {
    expect(canTransitionStreamState("IDLE", "INITIALIZING")).toBe(true);
    expect(transitionStreamState("IDLE", "INITIALIZING")).toBe("INITIALIZING");
    expect(transitionStreamState("READY", "ACTIVE")).toBe("ACTIVE");
    expect(transitionStreamState("ACTIVE", "STOPPING")).toBe("STOPPING");
  });

  it("rejects invalid transitions with a typed stream error", () => {
    expect(canTransitionStreamState("IDLE", "ACTIVE")).toBe(false);
    try {
      transitionStreamState("IDLE", "ACTIVE");
      throw new Error("Expected transition to fail.");
    } catch (error) {
      expect(error).toBeInstanceOf(CapCamError);
      expect((error as CapCamError).code).toBe("CAPCAM_STREAM_ERROR");
    }
  });
});
