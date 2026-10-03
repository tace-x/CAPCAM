import { isMediaId } from "../media/media-validation";
import type { StreamStatus } from "../shared/types";
import { isStreamErrorInfo, StreamEngineError, STREAM_ERROR_CODES, type StreamErrorInfo, type StreamErrorCode } from "./stream-errors";
import { isValidRenderConfig, type RenderConfig, type RenderableMediaSource } from "../canvas/render-types";

export type { StreamStatus } from "../shared/types";
export type { RenderConfig, RenderableMediaSource } from "../canvas/render-types";

export interface StreamStateSnapshot {
  status: StreamStatus;
  changedAt: number;
  errorMessage: string | null;
}

export interface TrackSettingsInfo {
  width: number | null;
  height: number | null;
  frameRate: number | null;
  aspectRatio: number | null;
}

export interface TrackInfo {
  id: string;
  label: string;
  kind: "video";
  readyState: "live" | "ended";
  enabled: boolean;
  muted: boolean;
  settings: TrackSettingsInfo;
}

export interface StreamTrackInfo {
  streamId: string;
  track: TrackInfo | null;
}

export interface StreamInfo {
  streamId: string | null;
  sourceMediaId: string | null;
  state: StreamStatus;
  config: RenderConfig | null;
  track: TrackInfo | null;
  error: StreamErrorInfo | null;
  disposed: boolean;
  changedAt: number;
}

export interface StreamCreateRequest {
  mediaId: string;
  config: RenderConfig;
}

export interface StreamIdPayload {
  streamId: string;
}

export interface StreamSwitchSourceRequest extends StreamIdPayload {
  mediaId: string;
}

export interface StreamMediaSourceProvider {
  getRenderableSource(mediaId: string): RenderableMediaSource;
}

export interface StreamPipelinePort {
  readonly sourceMediaId: string;
  readonly config: RenderConfig;
  getCanvas(): HTMLCanvasElement;
  getStream(): MediaStream;
  getTrack(): MediaStreamTrack;
  getTrackInfo(): TrackInfo;
  isRendering?(): boolean;
  start(): Promise<void>;
  stop(): Promise<void>;
  restart(): Promise<void>;
  switchSource(mediaId: string): Promise<void>;
  dispose(): Promise<void>;
}

export interface StreamPipelineFactory {
  create(
    mediaId: string,
    config: RenderConfig,
    onError: (error: unknown) => void,
  ): Promise<StreamPipelinePort>;
}

const STREAM_STATUSES: readonly StreamStatus[] = ["IDLE", "INITIALIZING", "READY", "ACTIVE", "STOPPING", "STOPPED", "ERROR"];

export function isStreamId(value: unknown): value is string {
  return typeof value === "string" && /^stream_[A-Za-z0-9-]{8,100}$/.test(value);
}

export function validateRenderConfig(config: RenderConfig): RenderConfig {
  if (!isValidRenderConfig(config)) {
    const value = typeof config === "object" && config !== null ? config as unknown as Record<string, unknown> : {};
    throw new StreamEngineError("STREAM_INVALID_CONFIG", undefined, {
      width: value.width,
      height: value.height,
      fps: value.fps,
      fitMode: value.fitMode,
    });
  }
  return { ...config };
}

function isPositiveOrNull(value: unknown): boolean {
  return value === null || (typeof value === "number" && Number.isFinite(value) && value > 0);
}

export function isTrackInfo(value: unknown): value is TrackInfo {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const settings = record.settings;
  if (typeof settings !== "object" || settings === null || Array.isArray(settings)) return false;
  const trackSettings = settings as Record<string, unknown>;
  return typeof record.id === "string" && record.id.length > 0 &&
    typeof record.label === "string" && record.label.length <= 128 &&
    record.kind === "video" && (record.readyState === "live" || record.readyState === "ended") &&
    typeof record.enabled === "boolean" && typeof record.muted === "boolean" &&
    Object.keys(trackSettings).length === 4 &&
    isPositiveOrNull(trackSettings.width) && isPositiveOrNull(trackSettings.height) &&
    isPositiveOrNull(trackSettings.frameRate) && isPositiveOrNull(trackSettings.aspectRatio) &&
    Object.keys(trackSettings).every((key) => ["width", "height", "frameRate", "aspectRatio"].includes(key)) &&
    Object.keys(record).length === 7 &&
    Object.keys(record).every((key) => ["id", "label", "kind", "readyState", "enabled", "muted", "settings"].includes(key));
}

export function isStreamInfo(value: unknown): value is StreamInfo {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (record.streamId === null || isStreamId(record.streamId)) &&
    (record.sourceMediaId === null || isMediaId(record.sourceMediaId)) &&
    typeof record.state === "string" && STREAM_STATUSES.includes(record.state as StreamStatus) &&
    (record.config === null || isValidRenderConfig(record.config)) &&
    (record.track === null || isTrackInfo(record.track)) &&
    (record.error === null || isStreamErrorInfo(record.error)) &&
    typeof record.disposed === "boolean" && typeof record.changedAt === "number" && Number.isFinite(record.changedAt) &&
    Object.keys(record).length === 8 &&
    Object.keys(record).every((key) => ["streamId", "sourceMediaId", "state", "config", "track", "error", "disposed", "changedAt"].includes(key));
}

export function isStreamTrackInfo(value: unknown): value is StreamTrackInfo {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return isStreamId(record.streamId) && (record.track === null || isTrackInfo(record.track)) &&
    Object.keys(record).length === 2 && Object.keys(record).every((key) => ["streamId", "track"].includes(key));
}

export function isStreamErrorCode(value: unknown): value is StreamErrorCode {
  return typeof value === "string" && STREAM_ERROR_CODES.includes(value as StreamErrorCode);
}
