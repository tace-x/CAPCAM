import { CapCamError } from "../shared/errors";
import type { MediaErrorCode, MediaErrorInfo } from "./media-types";

const DEFAULT_MESSAGES: Readonly<Record<MediaErrorCode, string>> = {
  MEDIA_UNSUPPORTED_TYPE: "This media format is not supported by CapCam in this browser.",
  MEDIA_DECODE_FAILED: "Chrome could not decode this media file.",
  MEDIA_INVALID_FILE: "The selected file is empty, corrupt, or does not match its declared media type.",
  MEDIA_METADATA_FAILED: "CapCam could not read valid dimensions or duration from this media.",
  MEDIA_TOO_LARGE: "This file exceeds CapCam's configured media size limit.",
  MEDIA_LOAD_TIMEOUT: "This media took too long to load.",
  MEDIA_RELEASED: "This media item has already been released.",
  MEDIA_NOT_FOUND: "The requested media item was not found.",
  MEDIA_CANCELLED: "Media loading was cancelled.",
  MEDIA_TRANSFER_FAILED: "CapCam could not hand the local file to the offscreen media engine.",
  MEDIA_INVALID_STATE: "This media lifecycle transition is not allowed.",
  MEDIA_RESOURCE_FAILED: "CapCam could not safely release this media resource.",
};

export class MediaEngineError extends CapCamError {
  readonly mediaCode: MediaErrorCode;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(
    mediaCode: MediaErrorCode,
    message: string = DEFAULT_MESSAGES[mediaCode],
    details?: Readonly<Record<string, unknown>>,
  ) {
    super("CAPCAM_MEDIA_ERROR", message, {
      mediaCode,
      ...(details === undefined ? {} : { details }),
    });
    this.name = "MediaEngineError";
    this.mediaCode = mediaCode;
    if (details !== undefined) this.details = details;
  }

  toInfo(): MediaErrorInfo {
    return this.details === undefined
      ? { code: this.mediaCode, message: this.message }
      : { code: this.mediaCode, message: this.message, details: this.details };
  }
}

export function toMediaEngineError(error: unknown, fallback: MediaErrorCode = "MEDIA_DECODE_FAILED"): MediaEngineError {
  if (error instanceof MediaEngineError) return error;
  const details = error instanceof Error ? { reason: error.message } : undefined;
  return new MediaEngineError(fallback, DEFAULT_MESSAGES[fallback], details);
}

export function mediaErrorInfo(error: unknown, fallback: MediaErrorCode = "MEDIA_DECODE_FAILED"): MediaErrorInfo {
  return toMediaEngineError(error, fallback).toInfo();
}
