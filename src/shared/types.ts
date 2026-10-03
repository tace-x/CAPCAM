import type { CapCamSettings } from "../storage/settings";

export type RuntimeStatus = "STARTING" | "READY" | "ERROR";
export type OffscreenStatus = "STARTING" | "READY" | "STOPPED" | "ERROR";
export type StreamStatus = "IDLE" | "INITIALIZING" | "READY" | "ACTIVE" | "STOPPING" | "STOPPED" | "ERROR";

export interface OffscreenRuntimeInfo {
  status: OffscreenStatus;
  initializedAt: number | null;
}

export interface CapCamState {
  runtime: {
    status: RuntimeStatus;
  };
  offscreen: {
    status: OffscreenStatus;
  };
  media: {
    activeMediaId: string | null;
  };
  stream: {
    status: StreamStatus;
  };
  settings: CapCamSettings;
}
