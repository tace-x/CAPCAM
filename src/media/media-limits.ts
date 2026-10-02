/** Default configurable ingestion ceiling (512 MiB); can be overridden when constructing MediaEngine. */
export const CAPCAM_MAX_MEDIA_SIZE_BYTES = 512 * 1024 * 1024;
export const IMAGE_LOAD_TIMEOUT_MS = 15_000;
export const VIDEO_LOAD_TIMEOUT_MS = 30_000;
export const MAX_CONCURRENT_MEDIA_LOADS = 3;
export const MEDIA_TRANSFER_TTL_MS = 10 * 60 * 1000;
