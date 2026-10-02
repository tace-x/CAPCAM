import { CapCamError } from "../shared/errors";
import { createLogger } from "../shared/logger";
import type { OffscreenRuntimeInfo } from "../shared/types";
import { MediaRuntime } from "./media-runtime";

const logger = createLogger("Offscreen");

export class OffscreenRuntime {
  private info: OffscreenRuntimeInfo = { status: "STARTING", initializedAt: null };
  private initialization: Promise<OffscreenRuntimeInfo> | null = null;

  constructor(private readonly mediaRuntime: MediaRuntime) {}

  initialize(): Promise<OffscreenRuntimeInfo> {
    if (this.info.status === "READY") return Promise.resolve(this.getStatus());
    if (this.initialization !== null) return this.initialization;

    this.initialization = Promise.resolve().then(() => {
      try {
        this.info = { status: "STARTING", initializedAt: null };
        this.mediaRuntime.initialize();
        this.info = { status: "READY", initializedAt: Date.now() };
        logger.info("Offscreen runtime ready.");
        return this.getStatus();
      } catch (error) {
        this.info = { status: "ERROR", initializedAt: null };
        const message = error instanceof Error ? error.message : "Media runtime initialization failed.";
        throw new CapCamError("CAPCAM_RUNTIME_ERROR", "Offscreen runtime initialization failed.", { reason: message });
      }
    }).finally(() => {
      this.initialization = null;
    });
    return this.initialization;
  }

  getStatus(): OffscreenRuntimeInfo {
    return { ...this.info };
  }

  async shutdown(): Promise<OffscreenRuntimeInfo> {
    try {
      this.mediaRuntime.shutdown();
      this.info = { status: "STOPPED", initializedAt: null };
      logger.info("Offscreen runtime stopped.");
      return this.getStatus();
    } catch (error) {
      this.info = { status: "ERROR", initializedAt: null };
      const message = error instanceof Error ? error.message : "Media runtime shutdown failed.";
      throw new CapCamError("CAPCAM_RUNTIME_ERROR", "Offscreen runtime shutdown failed.", { reason: message });
    }
  }
}
