import { describe, expect, it } from "vitest";
import { calculateAspectRatio } from "../../src/media/aspect-ratio";
import { generateMediaId } from "../../src/media/media-ids";
import { MediaEngineError } from "../../src/media/media-errors";
import { detectMediaFormat, sniffMediaMimeType } from "../../src/media/mime-detection";
import { createPngFile, createWebmHeaderFile } from "./fixtures";

describe("media IDs, MIME detection, and aspect ratio", () => {
  it("creates unique media IDs independent of filenames", () => {
    const first = generateMediaId();
    const second = generateMediaId();
    expect(first).toMatch(/^med_[A-Za-z0-9-]+$/);
    expect(second).not.toBe(first);
  });

  it("detects supported image/video signatures and generic browser MIME values", async () => {
    const png = createPngFile();
    const pngHeader = new Uint8Array(await png.slice(0, 16).arrayBuffer());
    const webm = createWebmHeaderFile();
    const webmHeader = new Uint8Array(await webm.slice(0, 16).arrayBuffer());

    expect(sniffMediaMimeType(pngHeader)).toBe("image/png");
    expect(detectMediaFormat("application/octet-stream", pngHeader)).toEqual({
      kind: "image",
      mimeType: "image/png",
      requiresDecodeConfirmation: false,
    });
    expect(detectMediaFormat("video/webm", webmHeader).kind).toBe("video");
  });

  it("accepts optional image MIME types only as decoder-confirmed candidates", () => {
    const avifHeader = new Uint8Array([
      0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66,
      0, 0, 0, 0, 0x61, 0x76, 0x69, 0x66, 0x6d, 0x69, 0x66, 0x31,
    ]);
    expect(detectMediaFormat("image/avif", avifHeader).requiresDecodeConfirmation).toBe(true);
  });

  it("rejects mismatched, unsupported, and QuickTime media types", () => {
    expect(() => detectMediaFormat("image/png", new Uint8Array([0xff, 0xd8, 0xff]))).toThrowError(MediaEngineError);
    expect(() => detectMediaFormat("text/plain", new Uint8Array([1, 2, 3]))).toThrowError(MediaEngineError);
    const quickTimeHeader = new Uint8Array([0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70, 0x71, 0x74, 0x20, 0x20]);
    expect(() => detectMediaFormat("video/quicktime", quickTimeHeader)).toThrowError(/not enabled by default/);
  });

  it("calculates common and arbitrary ratios and rejects invalid dimensions", () => {
    expect(calculateAspectRatio(1920, 1080)).toBeCloseTo(16 / 9);
    expect(calculateAspectRatio(1080, 1920)).toBeCloseTo(9 / 16);
    expect(calculateAspectRatio(1000, 1000)).toBe(1);
    expect(calculateAspectRatio(1600, 1200)).toBeCloseTo(4 / 3);
    expect(() => calculateAspectRatio(0, 1080)).toThrowError(MediaEngineError);
    expect(() => calculateAspectRatio(Number.NaN, 10)).toThrowError(MediaEngineError);
  });
});
