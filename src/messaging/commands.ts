import { PROTOCOL_VERSION } from "../shared/constants";
import type { CapCamState, OffscreenRuntimeInfo } from "../shared/types";
import type { CapCamSettings } from "../storage/settings";
import type { MediaClearResult, MediaIdPayload, MediaRecord, MediaRegisterPayload } from "../media/media-types";

export interface CommandMap {
  "runtime.getStatus": { payload: undefined; response: CapCamState };
  "offscreen.initialize": { payload: undefined; response: OffscreenRuntimeInfo };
  "offscreen.getStatus": { payload: undefined; response: OffscreenRuntimeInfo };
  "offscreen.shutdown": { payload: undefined; response: OffscreenRuntimeInfo };
  "settings.get": { payload: undefined; response: CapCamSettings };
  "settings.update": { payload: Partial<CapCamSettings>; response: CapCamSettings };
  "media.register": { payload: MediaRegisterPayload; response: MediaRecord };
  "media.get": { payload: MediaIdPayload; response: MediaRecord };
  "media.list": { payload: undefined; response: MediaRecord[] };
  "media.remove": { payload: MediaIdPayload; response: MediaRecord };
  "media.clear": { payload: undefined; response: MediaClearResult };
  "media.inspect": { payload: MediaIdPayload; response: MediaRecord };
}

export type CommandType = keyof CommandMap;
export type CommandPayload<T extends CommandType> = CommandMap[T]["payload"];
export type CommandResult<T extends CommandType> = CommandMap[T]["response"];
type CommandPayloadField<T extends CommandType> = CommandPayload<T> extends undefined
  ? { payload?: undefined }
  : { payload: CommandPayload<T> };

export type CommandEnvelope<T extends CommandType = CommandType> = T extends CommandType
  ? {
      protocol: typeof PROTOCOL_VERSION;
      requestId: string;
      type: T;
    } & CommandPayloadField<T>
  : never;

export type CommandArguments<T extends CommandType> = CommandPayload<T> extends undefined
  ? [payload?: undefined]
  : [payload: CommandPayload<T>];

let fallbackRequestCounter = 0;

export function generateRequestId(): string {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === "function") return cryptoApi.randomUUID();
  if (typeof cryptoApi?.getRandomValues === "function") {
    const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
    return `capcam-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  }
  fallbackRequestCounter += 1;
  return `capcam-${Date.now().toString(36)}-${fallbackRequestCounter.toString(36)}`;
}

export function createCommand<T extends CommandType>(
  type: T,
  ...args: CommandArguments<T>
): CommandEnvelope<T> {
  const requestId = generateRequestId();
  const payload = args[0];
  if (payload === undefined) {
    return { protocol: PROTOCOL_VERSION, requestId, type } as CommandEnvelope<T>;
  }
  return { protocol: PROTOCOL_VERSION, requestId, type, payload } as CommandEnvelope<T>;
}
