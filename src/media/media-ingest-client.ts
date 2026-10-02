import { MessagingClient } from "../messaging/client";
import { MediaEngineError } from "./media-errors";
import { CAPCAM_MAX_MEDIA_SIZE_BYTES } from "./media-limits";
import { IndexedDbMediaTransferStore, type MediaTransferStore } from "./media-transfer-store";
import type { MediaRecord } from "./media-types";

export class MediaIngestClient {
  constructor(
    private readonly messaging = new MessagingClient(),
    private readonly transferStore: MediaTransferStore = new IndexedDbMediaTransferStore(),
  ) {}

  async ingest(file: File): Promise<MediaRecord> {
    if (file.size > CAPCAM_MAX_MEDIA_SIZE_BYTES) {
      throw new MediaEngineError("MEDIA_TOO_LARGE", undefined, { size: file.size, maxSize: CAPCAM_MAX_MEDIA_SIZE_BYTES });
    }

    const transferId = await this.transferStore.stage(file);
    try {
      return await this.messaging.send("media.register", { transferId });
    } finally {
      try {
        await this.transferStore.delete(transferId);
      } catch {
        // Transfer records expire automatically; never mask the actual media result with cleanup failure.
      }
    }
  }
}
