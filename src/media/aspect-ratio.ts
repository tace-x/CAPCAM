import { MediaEngineError } from "./media-errors";

export function calculateAspectRatio(width: number, height: number): number {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new MediaEngineError("MEDIA_METADATA_FAILED", "Media dimensions must be finite positive numbers.", {
      width,
      height,
    });
  }
  return width / height;
}
