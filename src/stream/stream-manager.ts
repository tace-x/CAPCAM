import { createLogger } from "../shared/logger";
import type { StreamStatus } from "../shared/types";
import { transitionStreamState } from "./stream-state";
import type { StreamStateSnapshot } from "./stream-types";

const logger = createLogger("Stream");

export class StreamManager {
  private snapshot: StreamStateSnapshot = {
    status: "IDLE",
    changedAt: Date.now(),
    errorMessage: null,
  };

  getStatus(): StreamStateSnapshot {
    return { ...this.snapshot };
  }

  transition(status: StreamStatus, errorMessage: string | null = null): StreamStateSnapshot {
    const nextStatus = transitionStreamState(this.snapshot.status, status);
    this.snapshot = {
      status: nextStatus,
      changedAt: Date.now(),
      errorMessage: nextStatus === "ERROR" ? errorMessage : null,
    };
    logger.debug("Stream lifecycle state updated.", { status: nextStatus });
    return this.getStatus();
  }
}
