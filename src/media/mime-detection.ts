import { MediaEngineError } from "./media-errors";
import type { MediaKind } from "./media-types";

export const SUPPORTED_IMAGE_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
] as const;

export const SUPPORTED_VIDEO_MIME_TYPES = [
  "video/mp4",
  "video/webm",
  "video/ogg",
] as const;

const CORE_IMAGE_MIMES = new Set<string>(SUPPORTED_IMAGE_MIME_TYPES);
const VIDEO_MIMES = new Set<string>(SUPPORTED_VIDEO_MIME_TYPES);
const OPTIONAL_IMAGE_MIMES = new Set(["image/avif", "image/bmp", "image/x-icon", "image/jxl", "image/heic"]);
const GENERIC_MIMES = new Set(["", "application/octet-stream", "binary/octet-stream"]);

export interface DetectedMediaFormat {
  kind: MediaKind;
  mimeType: string;
  requiresDecodeConfirmation: boolean;
}

function text(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(start, start + length));
}

function hasBytes(bytes: Uint8Array, signature: readonly number[]): boolean {
  return signature.every((value, index) => bytes[index] === value);
}

function detectIsoBmff(bytes: Uint8Array): string | undefined {
  if (bytes.length < 12 || text(bytes, 4, 4) !== "ftyp") return undefined;
  const brands = new Set<string>();
  brands.add(text(bytes, 8, 4));
  for (let offset = 16; offset + 4 <= Math.min(bytes.length, 64); offset += 4) {
    brands.add(text(bytes, offset, 4));
  }
  if (brands.has("avif") || brands.has("avis")) return "image/avif";
  if (["heic", "heix", "hevc", "hevx", "mif1", "msf1"].some((brand) => brands.has(brand))) return "image/heic";
  if (brands.has("jxl ") || brands.has("jxlc")) return "image/jxl";
  if (brands.has("qt  ")) return "video/quicktime";
  return "video/mp4";
}

export function sniffMediaMimeType(header: Uint8Array): string | undefined {
  if (hasBytes(header, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (hasBytes(header, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (text(header, 0, 6) === "GIF87a" || text(header, 0, 6) === "GIF89a") return "image/gif";
  if (text(header, 0, 4) === "RIFF" && text(header, 8, 4) === "WEBP") return "image/webp";
  if (text(header, 0, 2) === "BM") return "image/bmp";
  if (hasBytes(header, [0x00, 0x00, 0x01, 0x00])) return "image/x-icon";
  if (hasBytes(header, [0xff, 0x0a])) return "image/jxl";
  if (hasBytes(header, [0x1a, 0x45, 0xdf, 0xa3])) return "video/webm";
  if (text(header, 0, 4) === "OggS") return "video/ogg";
  return detectIsoBmff(header);
}

export function normalizeMimeType(mimeType: string): string {
  return mimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

export function detectMediaFormat(declaredMimeType: string, header: Uint8Array): DetectedMediaFormat {
  const declared = normalizeMimeType(declaredMimeType);
  const sniffed = sniffMediaMimeType(header);

  if (sniffed === "video/quicktime") {
    throw new MediaEngineError("MEDIA_UNSUPPORTED_TYPE", "QuickTime/MOV containers are not enabled by default; browser decode support is not universal.", {
      declaredMimeType: declared || "unspecified",
    });
  }

  if (sniffed === undefined) {
    if (declared === "image/svg+xml" || declared === "image/svg") {
      throw new MediaEngineError("MEDIA_UNSUPPORTED_TYPE", "SVG files are not enabled for local image ingestion.");
    }
    throw new MediaEngineError("MEDIA_UNSUPPORTED_TYPE", "CapCam could not identify a supported image or video signature.", {
      declaredMimeType: declared || "unspecified",
    });
  }

  if (!GENERIC_MIMES.has(declared) && declared !== sniffed) {
    throw new MediaEngineError("MEDIA_INVALID_FILE", "The file's declared MIME type does not match its content.", {
      declaredMimeType: declared,
      detectedMimeType: sniffed,
    });
  }

  const kind: MediaKind = sniffed.startsWith("image/") ? "image" : "video";
  if (kind === "video" && !VIDEO_MIMES.has(sniffed)) {
    throw new MediaEngineError("MEDIA_UNSUPPORTED_TYPE", "This video container is not supported by CapCam.", {
      detectedMimeType: sniffed,
    });
  }
  if (kind === "image" && !CORE_IMAGE_MIMES.has(sniffed) && !OPTIONAL_IMAGE_MIMES.has(sniffed)) {
    throw new MediaEngineError("MEDIA_UNSUPPORTED_TYPE", "This image format is not supported by CapCam.", {
      detectedMimeType: sniffed,
    });
  }

  return {
    kind,
    mimeType: sniffed,
    requiresDecodeConfirmation: kind === "image" && !CORE_IMAGE_MIMES.has(sniffed),
  };
}
