import type { FitMode } from "../storage/settings";

export type RenderFitMode = FitMode;

export interface RenderConfig {
  width: number;
  height: number;
  fps: number;
  fitMode: RenderFitMode;
  mirror: boolean;
}

export interface RenderPreset {
  id: string;
  label: string;
  width: number;
  height: number;
  fps: number;
}

export interface RenderTransform {
  x: number;
  y: number;
  width: number;
  height: number;
  sourceX: number;
  sourceY: number;
  sourceWidth: number;
  sourceHeight: number;
}

/** DOM media resources are handles owned by Phase 02 resource managers, not protocol records. */
export type RenderableMediaSource =
  | { mediaId: string; kind: "image"; width: number; height: number; element: HTMLImageElement }
  | { mediaId: string; kind: "video"; width: number; height: number; element: HTMLVideoElement };

export const DEFAULT_RENDER_CONFIG: Readonly<RenderConfig> = Object.freeze({
  width: 1280,
  height: 720,
  fps: 30,
  fitMode: "cover",
  mirror: false,
});

export const RENDER_PRESETS: readonly RenderPreset[] = Object.freeze([
  { id: "1280x720@30", label: "1280 × 720 · 30 FPS", width: 1280, height: 720, fps: 30 },
  { id: "1280x720@60", label: "1280 × 720 · 60 FPS", width: 1280, height: 720, fps: 60 },
  { id: "1920x1080@30", label: "1920 × 1080 · 30 FPS", width: 1920, height: 1080, fps: 30 },
  { id: "1920x1080@60", label: "1920 × 1080 · 60 FPS", width: 1920, height: 1080, fps: 60 },
]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Shape validation for the protocol. Operational bounds are checked by validateRenderConfig(). */
export function isRenderConfigShape(value: unknown): value is RenderConfig {
  if (!isPlainRecord(value)) return false;
  return Object.keys(value).length === 5 &&
    typeof value.width === "number" && Number.isFinite(value.width) && Number.isInteger(value.width) &&
    typeof value.height === "number" && Number.isFinite(value.height) && Number.isInteger(value.height) &&
    typeof value.fps === "number" && Number.isFinite(value.fps) && Number.isInteger(value.fps) &&
    (value.fitMode === "cover" || value.fitMode === "contain") &&
    typeof value.mirror === "boolean" &&
    Object.keys(value).every((key) => ["width", "height", "fps", "fitMode", "mirror"].includes(key));
}

export function isValidRenderConfig(value: unknown): value is RenderConfig {
  return isRenderConfigShape(value) && value.width >= 1 && value.width <= 3840 &&
    value.height >= 1 && value.height <= 2160 && value.fps >= 1 && value.fps <= 60;
}

export function cloneRenderConfig(config: RenderConfig): RenderConfig {
  return { ...config };
}
