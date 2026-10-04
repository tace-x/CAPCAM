import { CapCamError } from "../shared/errors";

export const STREAM_ERROR_CODES = [
  "STREAM_INITIALIZATION_FAILED",
  "STREAM_CAPTURE_FAILED",
  "STREAM_NO_VIDEO_TRACK",
  "STREAM_INVALID_CONFIG",
  "STREAM_ALREADY_ACTIVE",
  "STREAM_NOT_READY",
  "STREAM_RENDER_FAILED",
  "STREAM_DISPOSED",
  "STREAM_NOT_FOUND",
  "STREAM_SOURCE_UNAVAILABLE",
  "CANVAS_INITIALIZATION_FAILED",
  "CANVAS_CONTEXT_FAILED",
  "FRAME_SCHEDULER_FAILED",
] as const;

export type StreamErrorCode = (typeof STREAM_ERROR_CODES)[number];

export interface StreamErrorInfo {
  code: StreamErrorCode;
  message: string;
  details?: Readonly<Record<string, unknown>>;
}

const DEFAULT_MESSAGES: Readonly<Record<StreamErrorCode, string>> = {
  STREAM_INITIALIZATION_FAILED: "CapCam could not initialize the local stream pipeline.",
  STREAM_CAPTURE_FAILED: "The browser could not capture a stream from the canvas.",
  STREAM_NO_VIDEO_TRACK: "The generated stream did not contain a video track.",
  STREAM_INVALID_CONFIG: "The requested rendering configuration is invalid or unsupported.",
  STREAM_ALREADY_ACTIVE: "A stream pipeline is already allocated or active.",
  STREAM_NOT_READY: "The stream is not ready for this operation.",
  STREAM_RENDER_FAILED: "CapCam could not render a media frame.",
  STREAM_DISPOSED: "This stream pipeline has been disposed.",
  STREAM_NOT_FOUND: "The requested stream was not found.",
  STREAM_SOURCE_UNAVAILABLE: "The selected media source is not ready for rendering.",
  CANVAS_INITIALIZATION_FAILED: "CapCam could not initialize the output canvas.",
  CANVAS_CONTEXT_FAILED: "A 2D canvas rendering context is unavailable.",
  FRAME_SCHEDULER_FAILED: "The frame scheduler could not run safely.",
};

export class StreamEngineError extends CapCamError {
  readonly streamCode: StreamErrorCode;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(
    streamCode: StreamErrorCode,
    message: string = DEFAULT_MESSAGES[streamCode],
    details?: Readonly<Record<string, unknown>>,
  ) {
    super("CAPCAM_STREAM_ERROR", message, {
      streamCode,
      ...(details === undefined ? {} : { details }),
    });
    this.name = "StreamEngineError";
    this.streamCode = streamCode;
    if (details !== undefined) this.details = details;
  }

  toInfo(): StreamErrorInfo {
    return this.details === undefined
      ? { code: this.streamCode, message: this.message }
      : { code: this.streamCode, message: this.message, details: this.details };
  }
}

export function isStreamErrorInfo(value: unknown): value is StreamErrorInfo {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return STREAM_ERROR_CODES.includes(record.code as StreamErrorCode) &&
    typeof record.message === "string" && record.message.length > 0 &&
    (!Object.hasOwn(record, "details") || (typeof record.details === "object" && record.details !== null && !Array.isArray(record.details))) &&
    Object.keys(record).every((key) => ["code", "message", "details"].includes(key));
}

export function toStreamEngineError(
  error: unknown,
  fallback: StreamErrorCode = "STREAM_INITIALIZATION_FAILED",
): StreamEngineError {
  if (error instanceof StreamEngineError) return error;
  const reason = error instanceof Error ? error.message : "Unknown browser media pipeline failure.";
  return new StreamEngineError(fallback, DEFAULT_MESSAGES[fallback], { reason });
}
