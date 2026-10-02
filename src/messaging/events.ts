import { PROTOCOL_VERSION } from "../shared/constants";
import type { CapCamState, OffscreenRuntimeInfo } from "../shared/types";
import type { CapCamSettings } from "../storage/settings";

export interface EventMap {
  "runtime.stateChanged": CapCamState;
  "offscreen.statusChanged": OffscreenRuntimeInfo;
  "settings.changed": CapCamSettings;
}

export type EventType = keyof EventMap;
export type EventEnvelope<T extends EventType = EventType> = T extends EventType
  ? { protocol: typeof PROTOCOL_VERSION; type: T; payload: EventMap[T] }
  : never;

export function createEvent<T extends EventType>(type: T, payload: EventMap[T]): EventEnvelope<T> {
  return { protocol: PROTOCOL_VERSION, type, payload } as EventEnvelope<T>;
}
