import { PROTOCOL_VERSION } from "../shared/constants";
import type { CapCamState, OffscreenRuntimeInfo } from "../shared/types";
import type { CapCamSettings } from "../storage/settings";
import type { MediaClearResult, MediaIdPayload, MediaRecord, MediaRegisterPayload } from "../media/media-types";
import type { StreamCreateRequest, StreamIdPayload, StreamInfo, StreamSwitchSourceRequest, StreamTrackInfo } from "../stream/stream-types";
import type { PlaybackIdPayload, PlaybackLoadRequest, PlaybackLoopRequest, PlaybackRateRequest, PlaybackRecord, PlaybackSeekRequest } from "../playback/playback-types";
import type { RuntimeDiagnostics, RuntimePingResponse, RuntimeStateSnapshot } from "../shared/runtime-types";
import type { CameraIntegrationStatusUpdate } from "../camera-integration/handoff";

export interface CommandMap {
  "runtime.getStatus": { payload: undefined; response: CapCamState };
  "runtime.initialize": { payload: undefined; response: RuntimeStateSnapshot };
  "runtime.shutdown": { payload: undefined; response: RuntimeStateSnapshot };
  "runtime.reset": { payload: undefined; response: RuntimeStateSnapshot };
  "runtime.getState": { payload: undefined; response: RuntimeStateSnapshot };
  "runtime.getDiagnostics": { payload: undefined; response: RuntimeDiagnostics };
  "runtime.ping": { payload: undefined; response: RuntimePingResponse };
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
  "stream.create": { payload: StreamCreateRequest; response: StreamInfo };
  "stream.getState": { payload: undefined; response: StreamInfo };
  "stream.start": { payload: StreamIdPayload; response: StreamInfo };
  "stream.stop": { payload: StreamIdPayload; response: StreamInfo };
  "stream.restart": { payload: StreamIdPayload; response: StreamInfo };
  "stream.switchSource": { payload: StreamSwitchSourceRequest; response: StreamInfo };
  "stream.getTrackInfo": { payload: StreamIdPayload; response: StreamTrackInfo };
  "stream.dispose": { payload: StreamIdPayload; response: StreamInfo };
  "playback.load": { payload: PlaybackLoadRequest; response: PlaybackRecord };
  "playback.play": { payload: PlaybackIdPayload; response: PlaybackRecord };
  "playback.pause": { payload: PlaybackIdPayload; response: PlaybackRecord };
  "playback.stop": { payload: PlaybackIdPayload; response: PlaybackRecord };
  "playback.restart": { payload: PlaybackIdPayload; response: PlaybackRecord };
  "playback.seek": { payload: PlaybackSeekRequest; response: PlaybackRecord };
  "playback.setLoop": { payload: PlaybackLoopRequest; response: PlaybackRecord };
  "playback.setRate": { payload: PlaybackRateRequest; response: PlaybackRecord };
  "playback.getState": { payload: undefined; response: PlaybackRecord | null };
  "playback.dispose": { payload: PlaybackIdPayload; response: PlaybackRecord | null };
  "camera.getStatus": { payload: undefined; response: CameraIntegrationStatusUpdate };
  "camera.detect": { payload: undefined; response: CameraIntegrationStatusUpdate };
  "camera.enable": { payload: undefined; response: CameraIntegrationStatusUpdate };
  "camera.disable": { payload: undefined; response: CameraIntegrationStatusUpdate };
  "camera.switchSource": { payload: MediaIdPayload; response: CameraIntegrationStatusUpdate };
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
      runtimeSessionId?: string;
    } & CommandPayloadField<T>
  : never;

export type CommandArguments<T extends CommandType> = CommandPayload<T> extends undefined
  ? [payload?: undefined]
  : [payload: CommandPayload<T>];

let fallbackRequestCounter = 0;

export function generateRequestId(): string {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === "function") return `req_${cryptoApi.randomUUID()}`;
  if (typeof cryptoApi?.getRandomValues === "function") {
    const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
    return `req_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  }
  fallbackRequestCounter += 1;
  return `req_${Date.now().toString(36)}_${fallbackRequestCounter.toString(36)}`;
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

export function attachRuntimeSessionId<T extends CommandType>(
  command: CommandEnvelope<T>,
  runtimeSessionId: string,
): CommandEnvelope<T> {
  return { ...command, runtimeSessionId };
}
