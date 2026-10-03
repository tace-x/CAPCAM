import { describe, expect, it } from "vitest";
import { calculateRenderTransform } from "../../src/canvas/render-transform";

describe("aspect-ratio render transforms", () => {
  it("centers and scales a landscape image without distortion for contain", () => {
    expect(calculateRenderTransform(1000, 500, 1280, 720, "contain")).toEqual({
      x: 0,
      y: 40,
      width: 1280,
      height: 640,
      sourceX: 0,
      sourceY: 0,
      sourceWidth: 1000,
      sourceHeight: 500,
    });
  });

  it("crops excess width symmetrically for cover", () => {
    const transform = calculateRenderTransform(1920, 1080, 720, 1280, "cover");
    expect(transform.x).toBe(0);
    expect(transform.y).toBe(0);
    expect(transform.width).toBe(720);
    expect(transform.height).toBe(1280);
    expect(transform.sourceX).toBeCloseTo(656.25);
    expect(transform.sourceY).toBe(0);
    expect(transform.sourceWidth).toBeCloseTo(607.5);
    expect(transform.sourceHeight).toBe(1080);
  });

  it("crops excess height symmetrically for cover and handles exact aspect matches", () => {
    const portrait = calculateRenderTransform(600, 1200, 1280, 720, "cover");
    expect(portrait.sourceY).toBeCloseTo(431.25);
    expect(portrait.sourceHeight).toBeCloseTo(337.5);
    expect(portrait.sourceWidth).toBe(600);

    const exact = calculateRenderTransform(16, 9, 1280, 720, "cover");
    expect(exact.sourceX).toBe(0);
    expect(exact.sourceY).toBe(0);
    expect(exact.sourceWidth).toBe(16);
    expect(exact.sourceHeight).toBe(9);
  });

  it("rejects invalid dimensions and unsupported fit modes", () => {
    expect(() => calculateRenderTransform(0, 10, 20, 20, "cover")).toThrowError(/dimensions/);
    expect(() => calculateRenderTransform(10, Number.NaN, 20, 20, "cover")).toThrowError(/dimensions/);
    expect(() => calculateRenderTransform(10, 10, 20, 20, "fill" as "cover")).toThrowError(/Fit mode/);
  });
});
