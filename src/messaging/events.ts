import { PROTOCOL_VERSION } from "../shared/constants";
import type { CapCamState, OffscreenRuntimeInfo } from "../shared/types";
import type { CapCamSettings } from "../storage/settings";
import type { MediaErrorInfo, MediaRecord } from "../media/media-types";

export interface EventMap {
  "runtime.stateChanged": CapCamState;
  "offscreen.statusChanged": OffscreenRuntimeInfo;
  "settings.changed": CapCamSettings;
  "media.registered": { mediaId: string; record: MediaRecord };
  "media.loading": { mediaId: string; record: MediaRecord };
  "media.ready": { mediaId: string; record: MediaRecord };
  "media.failed": { mediaId: string; record: MediaRecord; error: MediaErrorInfo };
  "media.removed": { mediaId: string };
  "media.released": { mediaId: string; record: MediaRecord };
}

export type EventType = keyof EventMap;
export type EventEnvelope<T extends EventType = EventType> = T extends EventType
  ? { protocol: typeof PROTOCOL_VERSION; type: T; payload: EventMap[T] }
  : never;

export function createEvent<T extends EventType>(type: T, payload: EventMap[T]): EventEnvelope<T> {
  return { protocol: PROTOCOL_VERSION, type, payload } as EventEnvelope<T>;
}
