import { CapCamError } from "../shared/errors";
import { MediaEngine } from "../media/media-engine";
import type { MediaClearResult, MediaIdPayload, MediaRecord, MediaRegisterPayload } from "../media/media-types";

export type MediaRuntimeStatus = "STARTING" | "READY" | "STOPPED" | "ERROR";

export interface MediaRuntimeInfo {
  status: MediaRuntimeStatus;
  initializedAt: number | null;
}

/** Offscreen-owned facade for local ingestion; it never starts playback or creates streams. */
export class MediaRuntime {
  private info: MediaRuntimeInfo = { status: "STARTING", initializedAt: null };

  constructor(private readonly engine: MediaEngine) {}

  async initialize(): Promise<MediaRuntimeInfo> {
    if (this.info.status === "READY") return this.getStatus();
    try {
      this.info = { status: "STARTING", initializedAt: null };
      await this.engine.initialize();
      this.info = { status: "READY", initializedAt: Date.now() };
      return this.getStatus();
    } catch (error) {
      this.info = { status: "ERROR", initializedAt: null };
      throw new CapCamError("CAPCAM_RUNTIME_ERROR", "Media runtime initialization failed.", {
        reason: error instanceof Error ? error.message : "Unknown media runtime initialization error.",
      });
    }
  }

  getStatus(): MediaRuntimeInfo {
    return { ...this.info };
  }

  register(payload: MediaRegisterPayload): Promise<MediaRecord> {
    return this.engine.register(payload.transferId);
  }

  get(payload: MediaIdPayload): MediaRecord {
    return this.engine.get(payload.mediaId);
  }

  list(): MediaRecord[] {
    return this.engine.list();
  }

  remove(payload: MediaIdPayload): Promise<MediaRecord> {
    return this.engine.remove(payload.mediaId);
  }

  clear(): Promise<MediaClearResult> {
    return this.engine.clear();
  }

  inspect(payload: MediaIdPayload): MediaRecord {
    return this.engine.inspect(payload.mediaId);
  }

  async shutdown(): Promise<MediaRuntimeInfo> {
    try {
      await this.engine.shutdown();
      this.info = { status: "STOPPED", initializedAt: null };
      return this.getStatus();
    } catch (error) {
      this.info = { status: "ERROR", initializedAt: null };
      throw new CapCamError("CAPCAM_RUNTIME_ERROR", "Media runtime shutdown failed.", {
        reason: error instanceof Error ? error.message : "Unknown media runtime shutdown error.",
      });
    }
  }
}
