export const CAPCAM_ERROR_CODES = [
  "CAPCAM_RUNTIME_ERROR",
  "CAPCAM_MEDIA_ERROR",
  "CAPCAM_STREAM_ERROR",
  "CAPCAM_PERMISSION_ERROR",
  "CAPCAM_SITE_ERROR",
  "CAPCAM_STORAGE_ERROR",
  "CAPCAM_PROTOCOL_ERROR",
] as const;

export type CapCamErrorCode = (typeof CAPCAM_ERROR_CODES)[number];
export type CapCamErrorMetadata = Readonly<Record<string, unknown>>;

export class CapCamError extends Error {
  readonly code: CapCamErrorCode;
  readonly metadata?: CapCamErrorMetadata;

  constructor(code: CapCamErrorCode, message: string, metadata?: CapCamErrorMetadata) {
    super(message);
    this.name = "CapCamError";
    this.code = code;
    if (metadata !== undefined) this.metadata = metadata;
  }
}

export function isCapCamErrorCode(value: unknown): value is CapCamErrorCode {
  return typeof value === "string" && CAPCAM_ERROR_CODES.some((code) => code === value);
}

export function toCapCamError(
  error: unknown,
  fallbackCode: CapCamErrorCode = "CAPCAM_RUNTIME_ERROR",
): CapCamError {
  if (error instanceof CapCamError) return error;
  if (error instanceof Error) {
    return new CapCamError(fallbackCode, error.message || "An unexpected CapCam error occurred.");
  }
  return new CapCamError(fallbackCode, "An unexpected CapCam error occurred.");
}

export function toErrorDetail(error: CapCamError): {
  code: CapCamErrorCode;
  message: string;
  metadata?: CapCamErrorMetadata;
} {
  return error.metadata === undefined
    ? { code: error.code, message: error.message }
    : { code: error.code, message: error.message, metadata: error.metadata };
}
