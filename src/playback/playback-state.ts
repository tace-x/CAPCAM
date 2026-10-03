import { PlaybackEngineError } from "./playback-errors";
import type { PlaybackState } from "./playback-types";

const ALLOWED_TRANSITIONS: Readonly<Record<PlaybackState, readonly PlaybackState[]>> = {
  IDLE: ["LOADING"],
  LOADING: ["READY", "ERROR", "IDLE"],
  READY: ["PLAYING", "STOPPED", "LOADING", "ERROR"],
  PLAYING: ["PAUSED", "ENDED", "STOPPED", "LOADING", "ERROR"],
  PAUSED: ["PLAYING", "STOPPED", "LOADING", "ERROR"],
  ENDED: ["PLAYING", "STOPPED", "LOADING", "ERROR"],
  STOPPED: ["PLAYING", "READY", "LOADING", "STOPPED", "ERROR"],
  ERROR: ["LOADING", "IDLE", "STOPPED"],
};

export function canTransitionPlaybackState(from: PlaybackState, to: PlaybackState): boolean {
  return from === to || ALLOWED_TRANSITIONS[from].includes(to);
}

export function transitionPlaybackState(from: PlaybackState, to: PlaybackState): PlaybackState {
  if (!canTransitionPlaybackState(from, to)) {
    throw new PlaybackEngineError("PLAYBACK_INVALID_STATE", "Playback state transition is not allowed.", { from, to });
  }
  return to;
}
