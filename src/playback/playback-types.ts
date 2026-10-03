import type { RenderableMediaSource } from "../canvas/render-types";
import { isMediaId } from "../media/media-validation";
import { isPlaybackErrorInfo, type PlaybackErrorInfo } from "./playback-errors";

export type PlaybackState = "IDLE" | "LOADING" | "READY" | "PLAYING" | "PAUSED" | "ENDED" | "STOPPED" | "ERROR";
export type PlaybackKind = "image" | "video";

export const PLAYBACK_RATE_OPTIONS = [0.25, 0.5, 1, 1.25, 1.5, 2] as const;
export type PlaybackRate = (typeof PLAYBACK_RATE_OPTIONS)[number];
export const DEFAULT_PLAYBACK_RATE: PlaybackRate = 1;

export interface PlaybackRecord {
  playbackId: string;
  mediaId: string;
  kind: PlaybackKind | null;
  state: PlaybackState;
  /** Video time in seconds; for images this is always 0 (no synthetic timeline). */
  currentTime: number;
  /** Video metadata duration or an optional image presentation duration. */
  duration: number | null;
  playbackRate: PlaybackRate;
  loop: boolean;
  startedAt: number | null;
  updatedAt: number;
  error: PlaybackErrorInfo | null;
}

export interface PlaybackLoadRequest {
  mediaId: string;
  /** Optional image presentation duration in seconds; omitted means hold until stopped/disposed. */
  imageDurationSeconds?: number;
}

export interface PlaybackIdPayload {
  playbackId: string;
}

export interface PlaybackSeekRequest extends PlaybackIdPayload {
  time: number;
}

export interface PlaybackLoopRequest extends PlaybackIdPayload {
  enabled: boolean;
}

export interface PlaybackRateRequest extends PlaybackIdPayload {
  rate: number;
}

export interface PlaybackSourceProvider {
  getRenderableSource(mediaId: string): RenderableMediaSource;
}

export interface PlaybackControllerPort {
  readonly playbackId: string;
  readonly mediaId: string;
  load(): Promise<PlaybackRecord>;
  play(): Promise<PlaybackRecord>;
  pause(): PlaybackRecord;
  stop(): PlaybackRecord;
  restart(): Promise<PlaybackRecord>;
  seek(time: number): PlaybackRecord;
  setLoop(enabled: boolean): PlaybackRecord;
  setPlaybackRate(rate: number): PlaybackRecord;
  getState(): PlaybackRecord;
  dispose(): PlaybackRecord;
}

export const PLAYBACK_STATES: readonly PlaybackState[] = [
  "IDLE", "LOADING", "READY", "PLAYING", "PAUSED", "ENDED", "STOPPED", "ERROR",
];

export function isPlaybackId(value: unknown): value is string {
  return typeof value === "string" && /^playback_[A-Za-z0-9-]{8,100}$/.test(value);
}

export function isPlaybackRate(value: unknown): value is PlaybackRate {
  return typeof value === "number" && PLAYBACK_RATE_OPTIONS.includes(value as PlaybackRate);
}

export function isPlaybackRecord(value: unknown): value is PlaybackRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const validDuration = record.duration === null ||
    (typeof record.duration === "number" && Number.isFinite(record.duration) && record.duration >= 0);
  const validStartedAt = record.startedAt === null ||
    (typeof record.startedAt === "number" && Number.isFinite(record.startedAt));
  return isPlaybackId(record.playbackId) && isMediaId(record.mediaId) &&
    (record.kind === null || record.kind === "image" || record.kind === "video") &&
    typeof record.state === "string" && PLAYBACK_STATES.includes(record.state as PlaybackState) &&
    typeof record.currentTime === "number" && Number.isFinite(record.currentTime) && record.currentTime >= 0 &&
    validDuration && isPlaybackRate(record.playbackRate) && typeof record.loop === "boolean" &&
    validStartedAt && typeof record.updatedAt === "number" && Number.isFinite(record.updatedAt) &&
    (record.error === null || isPlaybackErrorInfo(record.error)) &&
    Object.keys(record).length === 11 &&
    Object.keys(record).every((key) => [
      "playbackId", "mediaId", "kind", "state", "currentTime", "duration", "playbackRate", "loop", "startedAt", "updatedAt", "error",
    ].includes(key));
}
