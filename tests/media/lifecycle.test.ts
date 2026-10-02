import { describe, expect, it } from "vitest";
import { MediaEngineError } from "../../src/media/media-errors";
import { canTransitionMediaStatus, transitionMediaStatus } from "../../src/media/media-lifecycle";

describe("media lifecycle", () => {
  it("allows normal loading, ready, use, and release transitions", () => {
    expect(transitionMediaStatus("NEW", "VALIDATING")).toBe("VALIDATING");
    expect(transitionMediaStatus("VALIDATING", "LOADING")).toBe("LOADING");
    expect(transitionMediaStatus("LOADING", "READY")).toBe("READY");
    expect(transitionMediaStatus("READY", "IN_USE")).toBe("IN_USE");
    expect(transitionMediaStatus("IN_USE", "RELEASING")).toBe("RELEASING");
    expect(transitionMediaStatus("RELEASING", "RELEASED")).toBe("RELEASED");
  });

  it("allows load failure and rejects reuse after release", () => {
    expect(canTransitionMediaStatus("LOADING", "ERROR")).toBe(true);
    expect(() => transitionMediaStatus("RELEASED", "LOADING")).toThrowError(MediaEngineError);
  });
});
