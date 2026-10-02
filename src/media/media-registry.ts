import { CapCamError } from "../shared/errors";
import type { MediaSource } from "./media-source";
import type { MediaMetadata } from "./media-types";

function isValidMetadata(metadata: MediaMetadata): boolean {
  return (
    typeof metadata.mediaId === "string" && metadata.mediaId.length > 0 &&
    typeof metadata.name === "string" &&
    (metadata.type === "image" || metadata.type === "video") &&
    typeof metadata.mimeType === "string" &&
    Number.isFinite(metadata.size) && metadata.size >= 0 &&
    (metadata.duration === null || (Number.isFinite(metadata.duration) && metadata.duration >= 0)) &&
    (metadata.width === null || (Number.isInteger(metadata.width) && metadata.width > 0)) &&
    (metadata.height === null || (Number.isInteger(metadata.height) && metadata.height > 0)) &&
    (metadata.aspectRatio === null || (Number.isFinite(metadata.aspectRatio) && metadata.aspectRatio > 0))
  );
}

export class MediaRegistry {
  private readonly sources = new Map<string, MediaSource>();

  register(source: MediaSource): void {
    if (!isValidMetadata(source.metadata) || source.kind !== source.metadata.type) {
      throw new CapCamError("CAPCAM_MEDIA_ERROR", "Media source metadata is invalid.");
    }
    const mediaId = source.metadata.mediaId;
    if (this.sources.has(mediaId)) {
      throw new CapCamError("CAPCAM_MEDIA_ERROR", "A media source with this ID is already registered.", { mediaId });
    }
    this.sources.set(mediaId, source);
  }

  get(mediaId: string): MediaSource | undefined {
    return this.sources.get(mediaId);
  }

  listMetadata(): MediaMetadata[] {
    return Array.from(this.sources.values(), ({ metadata }) => ({ ...metadata }));
  }

  remove(mediaId: string): boolean {
    return this.sources.delete(mediaId);
  }

  clear(): void {
    this.sources.clear();
  }
}
