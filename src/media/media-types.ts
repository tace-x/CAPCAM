export type MediaKind = "image" | "video";

export type MediaStatus =
  | "NEW"
  | "VALIDATING"
  | "LOADING"
  | "READY"
  | "IN_USE"
  | "ERROR"
  | "RELEASING"
  | "RELEASED";

export type MediaErrorCode =
  | "MEDIA_UNSUPPORTED_TYPE"
  | "MEDIA_DECODE_FAILED"
  | "MEDIA_INVALID_FILE"
  | "MEDIA_METADATA_FAILED"
  | "MEDIA_TOO_LARGE"
  | "MEDIA_LOAD_TIMEOUT"
  | "MEDIA_RELEASED"
  | "MEDIA_NOT_FOUND"
  | "MEDIA_CANCELLED"
  | "MEDIA_TRANSFER_FAILED"
  | "MEDIA_INVALID_STATE"
  | "MEDIA_RESOURCE_FAILED";

export interface MediaErrorInfo {
  code: MediaErrorCode;
  message: string;
  details?: Readonly<Record<string, unknown>>;
}

export interface MediaMetadata {
  width: number | null;
  height: number | null;
  aspectRatio: number | null;
  duration: number | null;
}

export interface MediaCapabilities {
  canDecode: boolean;
  canSeek: boolean;
  supportsAudio: boolean;
}

/** Canonical runtime media record; no File/Blob or DOM object is stored here. */
export interface MediaRecord extends MediaMetadata {
  id: string;
  name: string;
  kind: MediaKind;
  mimeType: string;
  size: number;
  sourceUrl: string | null;
  createdAt: number;
  status: MediaStatus;
  capabilities: MediaCapabilities;
  error?: MediaErrorInfo;
}

export interface MediaRegisterPayload {
  transferId: string;
}

export interface MediaIdPayload {
  mediaId: string;
}

export interface MediaClearResult {
  removed: number;
}

export interface ImageResourceInfo {
  width: number;
  height: number;
}

export interface VideoResourceInfo {
  width: number;
  height: number;
  duration: number;
  canSeek: boolean;
  supportsAudio: boolean;
}
