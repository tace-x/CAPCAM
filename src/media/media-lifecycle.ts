import { MediaEngineError } from "./media-errors";
import type { MediaStatus } from "./media-types";

const ALLOWED_TRANSITIONS: Readonly<Record<MediaStatus, readonly MediaStatus[]>> = {
  NEW: ["VALIDATING", "ERROR", "RELEASING"],
  VALIDATING: ["LOADING", "ERROR", "RELEASING"],
  LOADING: ["READY", "ERROR", "RELEASING"],
  READY: ["IN_USE", "ERROR", "RELEASING"],
  IN_USE: ["READY", "ERROR", "RELEASING"],
  ERROR: ["RELEASING"],
  RELEASING: ["RELEASED"],
  RELEASED: [],
};

export function canTransitionMediaStatus(from: MediaStatus, to: MediaStatus): boolean {
  return from === to || ALLOWED_TRANSITIONS[from].includes(to);
}

export function transitionMediaStatus(from: MediaStatus, to: MediaStatus): MediaStatus {
  if (!canTransitionMediaStatus(from, to)) {
    throw new MediaEngineError("MEDIA_INVALID_STATE", undefined, { from, to });
  }
  return to;
}
