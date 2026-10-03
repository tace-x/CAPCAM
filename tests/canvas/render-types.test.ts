import { describe, expect, it } from "vitest";
import { DEFAULT_RENDER_CONFIG, isValidRenderConfig, RENDER_PRESETS } from "../../src/canvas/render-types";
import { DEFAULT_SETTINGS } from "../../src/storage/settings";

describe("Phase 03 render configuration", () => {
  it("uses the requested independent 1280×720 cover default without changing Phase 01 settings", () => {
    expect(DEFAULT_RENDER_CONFIG).toEqual({ width: 1280, height: 720, fps: 30, fitMode: "cover", mirror: false });
    expect(DEFAULT_SETTINGS.fitMode).toBe("contain");
  });

  it("offers each required resolution/FPS preset and rejects unsafe bounds", () => {
    expect(RENDER_PRESETS.map(({ width, height, fps }) => [width, height, fps])).toEqual([
      [1280, 720, 30],
      [1280, 720, 60],
      [1920, 1080, 30],
      [1920, 1080, 60],
    ]);
    expect(isValidRenderConfig({ width: 3840, height: 2160, fps: 60, fitMode: "contain", mirror: true })).toBe(true);
    expect(isValidRenderConfig({ width: 3841, height: 2160, fps: 30, fitMode: "cover", mirror: false })).toBe(false);
    expect(isValidRenderConfig({ width: 1280, height: 720, fps: 61, fitMode: "cover", mirror: false })).toBe(false);
  });
});
