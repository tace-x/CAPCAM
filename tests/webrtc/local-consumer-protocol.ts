export const LOCAL_CONSUMER_PROTOCOL_VERSION = 1 as const;

export interface LocalConsumerReadyMessage {
  protocol: typeof LOCAL_CONSUMER_PROTOCOL_VERSION;
  type: "capcam.local-consumer.ready";
}

export interface LocalConsumerStreamMessage<TStream = unknown> {
  protocol: typeof LOCAL_CONSUMER_PROTOCOL_VERSION;
  type: "capcam.local-consumer.stream";
  requestId: string;
  stream: TStream;
}

export interface LocalConsumerReceivedMessage {
  protocol: typeof LOCAL_CONSUMER_PROTOCOL_VERSION;
  type: "capcam.local-consumer.received";
  requestId: string;
  result: Record<string, unknown>;
}

export interface LocalConsumerDisposeMessage {
  protocol: typeof LOCAL_CONSUMER_PROTOCOL_VERSION;
  type: "capcam.local-consumer.dispose";
  requestId: string;
}

export interface LocalConsumerInspectMessage {
  protocol: typeof LOCAL_CONSUMER_PROTOCOL_VERSION;
  type: "capcam.local-consumer.inspect";
  requestId: string;
}

export interface LocalConsumerTrackSnapshot {
  kind: "video";
  id: string;
  label: string;
  readyState: "live" | "ended";
  enabled: boolean;
  muted: boolean;
  settings: {
    width: number | null;
    height: number | null;
    frameRate: number | null;
    aspectRatio: number | null;
  };
}

export interface LocalConsumerFrameEvidence {
  frameCallbackSupported: boolean;
  frameCount: number;
  firstMediaTime: number | null;
  lastMediaTime: number | null;
  videoWidth: number;
  videoHeight: number;
  videoReadyState: number;
  paused: boolean;
  trackReadyState: "live" | "ended";
  sampledDurationMs: number;
}

export interface LocalConsumerTrackSetSnapshot {
  streamPresent: boolean;
  streamId: string | null;
  streamActive: boolean | null;
  trackCount: number;
  tracks: LocalConsumerTrackSnapshot[];
}

export interface LocalConsumerInspectedMessage {
  protocol: typeof LOCAL_CONSUMER_PROTOCOL_VERSION;
  type: "capcam.local-consumer.inspected";
  requestId: string;
  result: LocalConsumerTrackSetSnapshot;
}

export interface LocalConsumerTrackEndedMessage {
  protocol: typeof LOCAL_CONSUMER_PROTOCOL_VERSION;
  type: "capcam.local-consumer.track-ended";
  requestId: string;
  streamId: string;
  track: LocalConsumerTrackSnapshot;
}

export interface LocalConsumerDisconnectedMessage {
  protocol: typeof LOCAL_CONSUMER_PROTOCOL_VERSION;
  type: "capcam.local-consumer.disconnected";
  requestId: string;
  reason: "pagehide";
  result: LocalConsumerTrackSetSnapshot;
}

export type LocalConsumerDiagnosticMessage = LocalConsumerTrackEndedMessage | LocalConsumerDisconnectedMessage;

export type LocalConsumerIntegrationState = "OFF" | "ERROR" | "TARGET_UNSUPPORTED";

export interface LocalConsumerDisposedMessage {
  protocol: typeof LOCAL_CONSUMER_PROTOCOL_VERSION;
  type: "capcam.local-consumer.disposed";
  requestId: string;
  result: {
    completed: boolean;
    integrationState: LocalConsumerIntegrationState;
    peerConnectionsClosed: boolean;
    localTracksEnded: boolean;
    error: string | null;
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

export function isLocalRequestId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function isLocalConsumerReadyMessage(value: unknown): value is LocalConsumerReadyMessage {
  return isPlainRecord(value) && value.protocol === LOCAL_CONSUMER_PROTOCOL_VERSION &&
    value.type === "capcam.local-consumer.ready" && hasExactKeys(value, ["protocol", "type"]);
}

export function isLocalConsumerStreamMessage<TStream>(
  value: unknown,
  isMediaStream: (candidate: unknown) => candidate is TStream,
): value is LocalConsumerStreamMessage<TStream> {
  return isPlainRecord(value) && value.protocol === LOCAL_CONSUMER_PROTOCOL_VERSION &&
    value.type === "capcam.local-consumer.stream" && isLocalRequestId(value.requestId) &&
    isMediaStream(value.stream) && hasExactKeys(value, ["protocol", "type", "requestId", "stream"]);
}

function isTrackSnapshot(value: unknown): value is LocalConsumerTrackSnapshot {
  if (!isPlainRecord(value) || !hasExactKeys(value, ["kind", "id", "label", "readyState", "enabled", "muted", "settings"])) return false;
  const settings = value.settings;
  if (value.kind !== "video" || typeof value.id !== "string" || value.id.length === 0 || value.id.length > 128 ||
    typeof value.label !== "string" || value.label.length > 128 ||
    (value.readyState !== "live" && value.readyState !== "ended") ||
    typeof value.enabled !== "boolean" || typeof value.muted !== "boolean" || !isPlainRecord(settings)) return false;
  if (!hasExactKeys(settings, ["width", "height", "frameRate", "aspectRatio"])) return false;
  return ["width", "height", "frameRate", "aspectRatio"].every((key) => {
    const setting = settings[key];
    return setting === null || (typeof setting === "number" && Number.isFinite(setting) && setting >= 0);
  });
}

function isConsumerTrackSetSnapshot(value: unknown): value is LocalConsumerTrackSetSnapshot {
  if (!isPlainRecord(value) || !hasExactKeys(value, ["streamPresent", "streamId", "streamActive", "trackCount", "tracks"]) ||
    typeof value.streamPresent !== "boolean" || !Array.isArray(value.tracks) || value.tracks.length > 16 ||
    !value.tracks.every(isTrackSnapshot) || typeof value.trackCount !== "number" ||
    !Number.isInteger(value.trackCount) || value.trackCount < 0 || value.trackCount > 16) return false;
  if (!value.streamPresent) {
    return value.streamId === null && value.streamActive === null && value.trackCount === 0 && value.tracks.length === 0;
  }
  return typeof value.streamId === "string" && value.streamId.length > 0 && value.streamId.length <= 128 &&
    typeof value.streamActive === "boolean" && value.trackCount === value.tracks.length;
}

function isLocalConsumerFrameEvidence(value: unknown): value is LocalConsumerFrameEvidence {
  if (!isPlainRecord(value) || !hasExactKeys(value, [
    "frameCallbackSupported", "frameCount", "firstMediaTime", "lastMediaTime", "videoWidth", "videoHeight",
    "videoReadyState", "paused", "trackReadyState", "sampledDurationMs",
  ])) return false;
  const validTime = (candidate: unknown): boolean => candidate === null ||
    (typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0);
  return typeof value.frameCallbackSupported === "boolean" &&
    typeof value.frameCount === "number" && Number.isInteger(value.frameCount) && value.frameCount >= 0 && value.frameCount <= 10_000 &&
    validTime(value.firstMediaTime) && validTime(value.lastMediaTime) &&
    typeof value.videoWidth === "number" && Number.isInteger(value.videoWidth) && value.videoWidth >= 0 && value.videoWidth <= 16_384 &&
    typeof value.videoHeight === "number" && Number.isInteger(value.videoHeight) && value.videoHeight >= 0 && value.videoHeight <= 16_384 &&
    typeof value.videoReadyState === "number" && Number.isInteger(value.videoReadyState) && value.videoReadyState >= 0 && value.videoReadyState <= 4 &&
    typeof value.paused === "boolean" && (value.trackReadyState === "live" || value.trackReadyState === "ended") &&
    typeof value.sampledDurationMs === "number" && Number.isFinite(value.sampledDurationMs) && value.sampledDurationMs >= 0 && value.sampledDurationMs <= 6_000 &&
    (value.frameCount === 0 || (value.videoWidth > 0 && value.videoHeight > 0 && value.firstMediaTime !== null && value.lastMediaTime !== null));
}

function isConsumerResult(value: unknown): value is Record<string, unknown> {
  if (!isPlainRecord(value) ||
    typeof value.accepted !== "boolean" ||
    typeof value.displayStarted !== "boolean" ||
    typeof value.isMediaStream !== "boolean" ||
    typeof value.trackCount !== "number" || !Number.isInteger(value.trackCount) || value.trackCount < 0 || value.trackCount > 16) return false;

  const allowed = ["accepted", "displayStarted", "isMediaStream", "trackCount", "message", "streamId", "tracks", "receiverOrigin", "error", "frameEvidence"] as const;
  if (!Object.keys(value).every((key) => (allowed as readonly string[]).includes(key))) return false;
  if (Object.hasOwn(value, "message") && (typeof value.message !== "string" || value.message.length > 400)) return false;
  if (Object.hasOwn(value, "error") && (typeof value.error !== "string" || value.error.length > 400)) return false;
  if (Object.hasOwn(value, "streamId") && (typeof value.streamId !== "string" || value.streamId.length > 128)) return false;
  if (Object.hasOwn(value, "receiverOrigin") && (typeof value.receiverOrigin !== "string" || value.receiverOrigin.length > 2_048)) return false;
  if (Object.hasOwn(value, "tracks") && (!Array.isArray(value.tracks) || value.tracks.length > 16 || !value.tracks.every(isTrackSnapshot))) return false;
  if (Object.hasOwn(value, "frameEvidence") && !isLocalConsumerFrameEvidence(value.frameEvidence)) return false;
  if (value.displayStarted && (!value.accepted || !value.isMediaStream || value.trackCount === 0)) return false;
  if (value.accepted && !value.isMediaStream) return false;
  return true;
}

export function isLocalConsumerReceivedMessage(value: unknown): value is LocalConsumerReceivedMessage {
  return isPlainRecord(value) && value.protocol === LOCAL_CONSUMER_PROTOCOL_VERSION &&
    value.type === "capcam.local-consumer.received" && isLocalRequestId(value.requestId) &&
    hasExactKeys(value, ["protocol", "type", "requestId", "result"]) && isConsumerResult(value.result);
}

export function isLocalConsumerDisposeMessage(value: unknown): value is LocalConsumerDisposeMessage {
  return isPlainRecord(value) && value.protocol === LOCAL_CONSUMER_PROTOCOL_VERSION &&
    value.type === "capcam.local-consumer.dispose" && isLocalRequestId(value.requestId) &&
    hasExactKeys(value, ["protocol", "type", "requestId"]);
}

export function isLocalConsumerInspectMessage(value: unknown): value is LocalConsumerInspectMessage {
  return isPlainRecord(value) && value.protocol === LOCAL_CONSUMER_PROTOCOL_VERSION &&
    value.type === "capcam.local-consumer.inspect" && isLocalRequestId(value.requestId) &&
    hasExactKeys(value, ["protocol", "type", "requestId"]);
}

export function isLocalConsumerInspectedMessage(value: unknown): value is LocalConsumerInspectedMessage {
  return isPlainRecord(value) && value.protocol === LOCAL_CONSUMER_PROTOCOL_VERSION &&
    value.type === "capcam.local-consumer.inspected" && isLocalRequestId(value.requestId) &&
    hasExactKeys(value, ["protocol", "type", "requestId", "result"]) && isConsumerTrackSetSnapshot(value.result);
}

export function isLocalConsumerDiagnosticMessage(value: unknown): value is LocalConsumerDiagnosticMessage {
  if (!isPlainRecord(value) || value.protocol !== LOCAL_CONSUMER_PROTOCOL_VERSION || !isLocalRequestId(value.requestId)) return false;
  if (value.type === "capcam.local-consumer.track-ended") {
    return hasExactKeys(value, ["protocol", "type", "requestId", "streamId", "track"]) &&
      typeof value.streamId === "string" && value.streamId.length > 0 && value.streamId.length <= 128 &&
      isTrackSnapshot(value.track) && value.track.readyState === "ended";
  }
  if (value.type === "capcam.local-consumer.disconnected") {
    return hasExactKeys(value, ["protocol", "type", "requestId", "reason", "result"]) &&
      value.reason === "pagehide" && isConsumerTrackSetSnapshot(value.result);
  }
  return false;
}

export function isLocalConsumerDisposedMessage(value: unknown): value is LocalConsumerDisposedMessage {
  if (!isPlainRecord(value) || value.protocol !== LOCAL_CONSUMER_PROTOCOL_VERSION ||
    value.type !== "capcam.local-consumer.disposed" || !isLocalRequestId(value.requestId) ||
    !hasExactKeys(value, ["protocol", "type", "requestId", "result"]) || !isPlainRecord(value.result)) return false;
  if (!hasExactKeys(value.result, ["completed", "integrationState", "peerConnectionsClosed", "localTracksEnded", "error"]) ||
    typeof value.result.completed !== "boolean" ||
    (value.result.integrationState !== "OFF" && value.result.integrationState !== "ERROR" && value.result.integrationState !== "TARGET_UNSUPPORTED") ||
    typeof value.result.peerConnectionsClosed !== "boolean" ||
    typeof value.result.localTracksEnded !== "boolean" ||
    (value.result.error !== null && (typeof value.result.error !== "string" || value.result.error.length > 400))) return false;
  return !value.result.completed || (value.result.integrationState === "OFF" &&
    value.result.peerConnectionsClosed && value.result.localTracksEnded && value.result.error === null);
}
