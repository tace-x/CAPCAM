export type MediaRuntimeStatus = "STARTING" | "READY" | "STOPPED" | "ERROR";

export interface MediaRuntimeInfo {
  status: MediaRuntimeStatus;
  initializedAt: number | null;
}

/** Lifecycle placeholder only; media decoding/rendering is intentionally deferred. */
export class MediaRuntime {
  private info: MediaRuntimeInfo = { status: "STARTING", initializedAt: null };

  initialize(): MediaRuntimeInfo {
    if (this.info.status !== "READY") {
      this.info = { status: "READY", initializedAt: Date.now() };
    }
    return this.getStatus();
  }

  getStatus(): MediaRuntimeInfo {
    return { ...this.info };
  }

  shutdown(): MediaRuntimeInfo {
    this.info = { status: "STOPPED", initializedAt: null };
    return this.getStatus();
  }
}
