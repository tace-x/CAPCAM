import { describe, expect, it, vi } from "vitest";
import { TrackInspector } from "../../src/stream/track-inspector";

describe("serializable video track inspection", () => {
  it("reports actual track settings while omitting raw browser data", () => {
    const track = {
      id: "local-track-id",
      label: "Canvas capture",
      kind: "video",
      readyState: "live",
      enabled: true,
      muted: false,
      getSettings: vi.fn(() => ({ width: 1920, height: 1080, frameRate: 29.97, deviceId: "must-not-escape" })),
    } as unknown as MediaStreamTrack;
    const info = new TrackInspector().inspect(track);
    expect(info).toEqual({
      id: "local-track-id",
      label: "Canvas capture",
      kind: "video",
      readyState: "live",
      enabled: true,
      muted: false,
      settings: { width: 1920, height: 1080, frameRate: 29.97, aspectRatio: 16 / 9 },
    });
    expect(JSON.stringify(info)).not.toContain("deviceId");
  });

  it("returns null for no track and gracefully marks unavailable browser settings", () => {
    const inspector = new TrackInspector();
    expect(inspector.inspect(null)).toBeNull();
    const track = {
      id: "local-track-id",
      label: "",
      kind: "video",
      readyState: "ended",
      enabled: false,
      muted: true,
      getSettings: () => { throw new Error("not ready"); },
    } as unknown as MediaStreamTrack;
    expect(inspector.inspect(track)?.settings).toEqual({ width: null, height: null, frameRate: null, aspectRatio: null });
  });
});
