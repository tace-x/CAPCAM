import { CapCamError } from "../shared/errors";
import type { StreamStatus } from "../shared/types";

const ALLOWED_TRANSITIONS: Readonly<Record<StreamStatus, readonly StreamStatus[]>> = {
  IDLE: ["INITIALIZING"],
  INITIALIZING: ["READY", "STOPPING", "ERROR"],
  READY: ["ACTIVE", "STOPPING", "ERROR"],
  ACTIVE: ["STOPPING", "ERROR"],
  STOPPING: ["STOPPED", "ERROR"],
  STOPPED: ["INITIALIZING", "IDLE"],
  ERROR: ["IDLE", "INITIALIZING", "STOPPING", "STOPPED"],
};

export function canTransitionStreamState(from: StreamStatus, to: StreamStatus): boolean {
  return from === to || ALLOWED_TRANSITIONS[from].includes(to);
}

export function transitionStreamState(from: StreamStatus, to: StreamStatus): StreamStatus {
  if (!canTransitionStreamState(from, to)) {
    throw new CapCamError("CAPCAM_STREAM_ERROR", "Stream state transition is not allowed.", { from, to });
  }
  return to;
}
