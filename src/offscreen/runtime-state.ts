import { CapCamError } from "../shared/errors";
import type { RuntimeState } from "../shared/runtime-types";

const ALLOWED_TRANSITIONS: Readonly<Record<RuntimeState, readonly RuntimeState[]>> = {
  created: ["initializing", "stopping", "stopped", "resetting", "error"],
  initializing: ["ready", "stopping", "resetting", "error"],
  ready: ["active", "stopping", "resetting", "error"],
  active: ["ready", "stopping", "resetting", "error"],
  stopping: ["stopped", "error"],
  stopped: ["initializing", "resetting", "stopped", "stopping"],
  resetting: ["initializing", "stopped", "error"],
  error: ["resetting", "stopping", "stopped"],
};

export function canTransitionRuntimeState(from: RuntimeState, to: RuntimeState): boolean {
  return from === to || ALLOWED_TRANSITIONS[from].includes(to);
}

export function transitionRuntimeState(from: RuntimeState, to: RuntimeState): RuntimeState {
  if (!canTransitionRuntimeState(from, to)) {
    throw new CapCamError("RUNTIME_INVALID_TRANSITION", "Runtime state transition is not allowed.", { from, to });
  }
  return to;
}
