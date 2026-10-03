import type { MediaErrorCode, MediaRecord, MediaStatus } from "./media-types";

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const MEDIA_STATUSES: readonly MediaStatus[] = [
  "NEW", "VALIDATING", "LOADING", "READY", "IN_USE", "ERROR", "RELEASING", "RELEASED",
];
const MEDIA_ERROR_CODES: readonly MediaErrorCode[] = [
  "MEDIA_UNSUPPORTED_TYPE",
  "MEDIA_DECODE_FAILED",
  "MEDIA_INVALID_FILE",
  "MEDIA_METADATA_FAILED",
  "MEDIA_TOO_LARGE",
  "MEDIA_LOAD_TIMEOUT",
  "MEDIA_RELEASED",
  "MEDIA_NOT_FOUND",
  "MEDIA_CANCELLED",
  "MEDIA_TRANSFER_FAILED",
  "MEDIA_INVALID_STATE",
  "MEDIA_RESOURCE_FAILED",
];

export function isMediaId(value: unknown): value is string {
  return typeof value === "string" && /^med_[A-Za-z0-9-]{8,100}$/.test(value);
}

export function isTransferId(value: unknown): value is string {
  return typeof value === "string" && /^transfer_[A-Za-z0-9-]{8,100}$/.test(value);
}

function nullablePositiveNumber(value: unknown): boolean {
  return value === null || (typeof value === "number" && Number.isFinite(value) && value > 0);
}

function nullablePositiveInteger(value: unknown): boolean {
  return value === null || (typeof value === "number" && Number.isInteger(value) && value > 0);
}

export function isMediaErrorInfo(value: unknown): boolean {
  if (!isPlainRecord(value)) return false;
  if (!MEDIA_ERROR_CODES.includes(value.code as MediaErrorCode) || typeof value.message !== "string" || value.message.length === 0) {
    return false;
  }
  if (Object.hasOwn(value, "details") && !isPlainRecord(value.details)) return false;
  return Object.keys(value).every((key) => ["code", "message", "details"].includes(key));
}

export function isMediaRecord(value: unknown): value is MediaRecord {
  if (!isPlainRecord(value)) return false;
  const capabilities = value.capabilities;
  const hasError = Object.hasOwn(value, "error");
  return isMediaId(value.id) &&
    typeof value.name === "string" && value.name.length <= 255 &&
    (value.kind === "image" || value.kind === "video") &&
    typeof value.mimeType === "string" && value.mimeType.length > 0 &&
    typeof value.size === "number" && Number.isFinite(value.size) && value.size >= 0 &&
    nullablePositiveInteger(value.width) && nullablePositiveInteger(value.height) &&
    nullablePositiveNumber(value.aspectRatio) &&
    (value.duration === null || (typeof value.duration === "number" && Number.isFinite(value.duration) && value.duration >= 0)) &&
    (value.sourceUrl === null || (typeof value.sourceUrl === "string" && value.sourceUrl.startsWith("blob:"))) &&
    typeof value.createdAt === "number" && Number.isFinite(value.createdAt) &&
    MEDIA_STATUSES.includes(value.status as MediaStatus) &&
    isPlainRecord(capabilities) &&
    typeof capabilities.canDecode === "boolean" &&
    typeof capabilities.canSeek === "boolean" &&
    typeof capabilities.supportsAudio === "boolean" &&
    Object.keys(capabilities).length === 3 &&
    (!hasError || isMediaErrorInfo(value.error)) &&
    Object.keys(value).every((key) => [
      "id", "name", "kind", "mimeType", "size", "width", "height", "aspectRatio", "duration",
      "sourceUrl", "createdAt", "status", "capabilities", "error",
    ].includes(key));
}
