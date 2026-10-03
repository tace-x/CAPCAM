import { CapCamError } from "../shared/errors";

export const PLAYBACK_ERROR_CODES = [
  "PLAYBACK_MEDIA_NOT_FOUND",
  "PLAYBACK_LOAD_FAILED",
  "PLAYBACK_PLAY_FAILED",
  "PLAYBACK_SEEK_FAILED",
  "PLAYBACK_INVALID_TIME",
  "PLAYBACK_INVALID_RATE",
  "PLAYBACK_INVALID_STATE",
  "PLAYBACK_DISPOSED",
  "PLAYBACK_SOURCE_ENDED",
  "PLAYBACK_NOT_FOUND",
] as const;

export type PlaybackErrorCode = (typeof PLAYBACK_ERROR_CODES)[number];

export interface PlaybackErrorInfo {
  code: PlaybackErrorCode;
  message: string;
  details?: Readonly<Record<string, unknown>>;
}

const DEFAULT_MESSAGES: Readonly<Record<PlaybackErrorCode, string>> = {
  PLAYBACK_MEDIA_NOT_FOUND: "The requested media is not available for playback.",
  PLAYBACK_LOAD_FAILED: "The media source could not be loaded for playback.",
  PLAYBACK_PLAY_FAILED: "The browser rejected the playback request.",
  PLAYBACK_SEEK_FAILED: "The media position could not be changed.",
  PLAYBACK_INVALID_TIME: "Seek time must be a finite number.",
  PLAYBACK_INVALID_RATE: "Playback rate is not supported.",
  PLAYBACK_INVALID_STATE: "The playback operation is not valid in the current state.",
  PLAYBACK_DISPOSED: "The playback controller has been disposed.",
  PLAYBACK_SOURCE_ENDED: "The source has ended and cannot continue playing.",
  PLAYBACK_NOT_FOUND: "The requested playback session was not found.",
};

export class PlaybackEngineError extends CapCamError {
  readonly playbackCode: PlaybackErrorCode;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(
    playbackCode: PlaybackErrorCode,
    message: string = DEFAULT_MESSAGES[playbackCode],
    details?: Readonly<Record<string, unknown>>,
  ) {
    super("CAPCAM_PLAYBACK_ERROR", message, {
      playbackCode,
      ...(details === undefined ? {} : { details }),
    });
    this.name = "PlaybackEngineError";
    this.playbackCode = playbackCode;
    if (details !== undefined) this.details = details;
  }

  toInfo(): PlaybackErrorInfo {
    return this.details === undefined
      ? { code: this.playbackCode, message: this.message }
      : { code: this.playbackCode, message: this.message, details: this.details };
  }
}

export function isPlaybackErrorInfo(value: unknown): value is PlaybackErrorInfo {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return PLAYBACK_ERROR_CODES.includes(record.code as PlaybackErrorCode) &&
    typeof record.message === "string" && record.message.length > 0 &&
    (!Object.hasOwn(record, "details") || (typeof record.details === "object" && record.details !== null && !Array.isArray(record.details))) &&
    Object.keys(record).every((key) => ["code", "message", "details"].includes(key));
}

export function toPlaybackEngineError(
  error: unknown,
  fallback: PlaybackErrorCode = "PLAYBACK_LOAD_FAILED",
): PlaybackEngineError {
  if (error instanceof PlaybackEngineError) return error;
  const reason = error instanceof Error ? error.message : "Unknown browser playback failure.";
  return new PlaybackEngineError(fallback, DEFAULT_MESSAGES[fallback], { reason });
}
