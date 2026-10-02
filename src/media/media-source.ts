import type { MediaMetadata, MediaType } from "./media-types";

/** Descriptor contract for future local image/video sources. This phase stores no media bytes. */
export interface MediaSource {
  readonly kind: MediaType;
  readonly metadata: Readonly<MediaMetadata>;
}
