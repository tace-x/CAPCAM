import { DEFAULT_SETTINGS } from "../storage/settings";
import type { CapCamState } from "./types";

export function createInitialCapCamState(): CapCamState {
  return {
    runtime: { status: "STARTING" },
    offscreen: { status: "STOPPED" },
    media: { activeMediaId: null },
    stream: { status: "IDLE" },
    settings: { ...DEFAULT_SETTINGS },
  };
}
