import { PROTOCOL_VERSION } from "../shared/constants";
import { CapCamError, isCapCamErrorCode, toErrorDetail, type CapCamErrorCode } from "../shared/errors";
import type { CapCamState, OffscreenRuntimeInfo, OffscreenStatus, RuntimeStatus, StreamStatus } from "../shared/types";
import { isCapCamSettings, isSettingsPatch } from "../storage/settings";
import { isMediaErrorInfo, isMediaId, isMediaRecord, isTransferId } from "../media/media-validation";
import { isValidRenderConfig } from "../canvas/render-types";
import { isStreamId, isStreamInfo, isStreamTrackInfo } from "../stream/stream-types";
import { isPlaybackId, isPlaybackRecord } from "../playback/playback-types";
import { PLAYBACK_EVENT_TYPES, type PlaybackEventType } from "../playback/playback-events";
import { isRuntimeDiagnostics, isRuntimePingResponse, isRuntimeSessionId, isRuntimeStateSnapshot } from "../shared/runtime-types";
import type { CommandEnvelope, CommandType } from "./commands";
import type { EventEnvelope, EventType } from "./events";

export interface ResponseError {
  code: CapCamErrorCode;
  message: string;
  metadata?: Readonly<Record<string, unknown>>;
}

export interface ResponseEnvelope<T = unknown> {
  protocol: typeof PROTOCOL_VERSION;
  requestId: string;
  success: boolean;
  runtimeSessionId?: string;
  data?: T;
  error?: ResponseError;
}

export type CommandValidationResult =
  | { ok: true; command: CommandEnvelope }
  | { ok: false; requestId?: string; error: CapCamError };

const VALID_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const RUNTIME_STATUSES: readonly RuntimeStatus[] = ["STARTING", "READY", "ERROR"];
const OFFSCREEN_STATUSES: readonly OffscreenStatus[] = ["STARTING", "READY", "STOPPED", "ERROR"];
const STREAM_STATUSES: readonly StreamStatus[] = ["IDLE", "INITIALIZING", "READY", "ACTIVE", "STOPPING", "STOPPED", "ERROR"];
const COMMAND_TYPES: readonly CommandType[] = [
  "runtime.getStatus",
  "runtime.initialize",
  "runtime.shutdown",
  "runtime.reset",
  "runtime.getState",
  "runtime.getDiagnostics",
  "runtime.ping",
  "offscreen.initialize",
  "offscreen.getStatus",
  "offscreen.shutdown",
  "settings.get",
  "settings.update",
  "media.register",
  "media.get",
  "media.list",
  "media.remove",
  "media.clear",
  "media.inspect",
  "stream.create",
  "stream.getState",
  "stream.start",
  "stream.stop",
  "stream.restart",
  "stream.switchSource",
  "stream.getTrackInfo",
  "stream.dispose",
  "playback.load",
  "playback.play",
  "playback.pause",
  "playback.stop",
  "playback.restart",
  "playback.seek",
  "playback.setLoop",
  "playback.setRate",
  "playback.getState",
  "playback.dispose",
];
const EVENT_TYPES: readonly EventType[] = [
  "runtime.stateChanged",
  "runtime.lifecycleChanged",
  "offscreen.statusChanged",
  "settings.changed",
  "media.registered",
  "media.loading",
  "media.ready",
  "media.failed",
  "media.removed",
  "media.released",
  "stream.stateChanged",
  ...PLAYBACK_EVENT_TYPES,
];

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isRequestId(value: unknown): value is string {
  return typeof value === "string" && VALID_REQUEST_ID.test(value);
}

export function extractRequestId(value: unknown): string | undefined {
  if (!isPlainRecord(value) || !isRequestId(value.requestId)) return undefined;
  return value.requestId;
}

function makeProtocolError(message: string, metadata?: Record<string, unknown>): CapCamError {
  return metadata === undefined
    ? new CapCamError("CAPCAM_PROTOCOL_ERROR", message)
    : new CapCamError("CAPCAM_PROTOCOL_ERROR", message, metadata);
}

export function validateCommand(value: unknown): CommandValidationResult {
  const requestId = extractRequestId(value);
  if (!isPlainRecord(value)) {
    return { ok: false, error: makeProtocolError("Command envelope must be an object.") };
  }
  if (value.protocol !== PROTOCOL_VERSION) {
    return {
      ok: false,
      ...(requestId === undefined ? {} : { requestId }),
      error: makeProtocolError("Unsupported protocol version.", { received: value.protocol }),
    };
  }
  if (requestId === undefined) {
    return { ok: false, error: makeProtocolError("Command request ID is missing or invalid.") };
  }
  if (typeof value.type !== "string" || !COMMAND_TYPES.includes(value.type as CommandType)) {
    return {
      ok: false,
      requestId,
      error: makeProtocolError("Command type is not supported.", {
        type: typeof value.type === "string" ? value.type : "invalid",
      }),
    };
  }

  const type = value.type as CommandType;
  const payloadCommands: readonly CommandType[] = [
    "settings.update", "media.register", "media.get", "media.remove", "media.inspect",
    "stream.create", "stream.start", "stream.stop", "stream.restart", "stream.switchSource",
    "stream.getTrackInfo", "stream.dispose",
    "playback.load", "playback.play", "playback.pause", "playback.stop", "playback.restart",
    "playback.seek", "playback.setLoop", "playback.setRate", "playback.dispose",
  ];
  const allowedKeys = payloadCommands.includes(type)
    ? ["protocol", "requestId", "type", "payload", "runtimeSessionId"]
    : ["protocol", "requestId", "type", "runtimeSessionId"];
  if (Object.keys(value).some((key) => !allowedKeys.includes(key))) {
    return { ok: false, requestId, error: makeProtocolError("Command envelope contains unsupported fields.") };
  }
  if (Object.hasOwn(value, "runtimeSessionId") && !isRuntimeSessionId(value.runtimeSessionId)) {
    return { ok: false, requestId, error: makeProtocolError("Runtime session ID is invalid.") };
  }

  const payload = value.payload;
  let validPayload = true;
  switch (type) {
    case "settings.update":
      validPayload = Object.hasOwn(value, "payload") && isSettingsPatch(payload);
      break;
    case "media.register":
      validPayload = isPlainRecord(payload) && Object.keys(payload).length === 1 && isTransferId(payload.transferId);
      break;
    case "media.get":
    case "media.remove":
    case "media.inspect":
      validPayload = isPlainRecord(payload) && Object.keys(payload).length === 1 && isMediaId(payload.mediaId);
      break;
    case "stream.create":
      validPayload = isPlainRecord(payload) && Object.keys(payload).length === 2 &&
        isMediaId(payload.mediaId) && isValidRenderConfig(payload.config);
      break;
    case "stream.start":
    case "stream.stop":
    case "stream.restart":
    case "stream.getTrackInfo":
    case "stream.dispose":
      validPayload = isPlainRecord(payload) && Object.keys(payload).length === 1 && isStreamId(payload.streamId);
      break;
    case "stream.switchSource":
      validPayload = isPlainRecord(payload) && Object.keys(payload).length === 2 &&
        isStreamId(payload.streamId) && isMediaId(payload.mediaId);
      break;
    case "playback.load":
      validPayload = isPlainRecord(payload) &&
        (Object.keys(payload).length === 1 || Object.keys(payload).length === 2) &&
        isMediaId(payload.mediaId) &&
        (!Object.hasOwn(payload, "imageDurationSeconds") || typeof payload.imageDurationSeconds === "number") &&
        Object.keys(payload).every((key) => ["mediaId", "imageDurationSeconds"].includes(key));
      break;
    case "playback.play":
    case "playback.pause":
    case "playback.stop":
    case "playback.restart":
    case "playback.dispose":
      validPayload = isPlainRecord(payload) && Object.keys(payload).length === 1 && isPlaybackId(payload.playbackId);
      break;
    case "playback.seek":
      validPayload = isPlainRecord(payload) && Object.keys(payload).length === 2 &&
        isPlaybackId(payload.playbackId) && typeof payload.time === "number";
      break;
    case "playback.setLoop":
      validPayload = isPlainRecord(payload) && Object.keys(payload).length === 2 &&
        isPlaybackId(payload.playbackId) && typeof payload.enabled === "boolean";
      break;
    case "playback.setRate":
      validPayload = isPlainRecord(payload) && Object.keys(payload).length === 2 &&
        isPlaybackId(payload.playbackId) && typeof payload.rate === "number";
      break;
    default:
      validPayload = !Object.hasOwn(value, "payload");
  }
  if (!validPayload) {
    return { ok: false, requestId, error: makeProtocolError("Command payload is invalid or unsupported.") };
  }

  return { ok: true, command: value as unknown as CommandEnvelope };
}

export function createSuccessResponse<T>(requestId: string, data: T, runtimeSessionId?: string): ResponseEnvelope<T> {
  return {
    protocol: PROTOCOL_VERSION,
    requestId,
    success: true,
    ...(runtimeSessionId === undefined ? {} : { runtimeSessionId }),
    data,
  };
}

export function createErrorResponse(requestId: string, error: CapCamError, runtimeSessionId?: string): ResponseEnvelope<never> {
  return {
    protocol: PROTOCOL_VERSION,
    requestId,
    success: false,
    ...(runtimeSessionId === undefined ? {} : { runtimeSessionId }),
    error: toErrorDetail(error),
  };
}

function isResponseError(value: unknown): value is ResponseError {
  if (!isPlainRecord(value)) return false;
  if (!isCapCamErrorCode(value.code) || typeof value.message !== "string" || value.message.length === 0) return false;
  if (Object.hasOwn(value, "metadata") && !isPlainRecord(value.metadata)) return false;
  return Object.keys(value).every((key) => ["code", "message", "metadata"].includes(key));
}

export function isResponseEnvelope(value: unknown): value is ResponseEnvelope {
  if (!isPlainRecord(value) || value.protocol !== PROTOCOL_VERSION || !isRequestId(value.requestId)) return false;
  const validSession = !Object.hasOwn(value, "runtimeSessionId") || isRuntimeSessionId(value.runtimeSessionId);
  if (!validSession) return false;
  if (value.success === true) {
    return Object.hasOwn(value, "data") && !Object.hasOwn(value, "error") &&
      Object.keys(value).every((key) => ["protocol", "requestId", "success", "runtimeSessionId", "data"].includes(key));
  }
  if (value.success === false) {
    return Object.hasOwn(value, "error") && !Object.hasOwn(value, "data") && isResponseError(value.error) &&
      Object.keys(value).every((key) => ["protocol", "requestId", "success", "runtimeSessionId", "error"].includes(key));
  }
  return false;
}

function isStatus<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === "string" && values.includes(value as T);
}

function isOffscreenRuntimeInfo(value: unknown): value is OffscreenRuntimeInfo {
  return isPlainRecord(value) &&
    isStatus(value.status, OFFSCREEN_STATUSES) &&
    (value.initializedAt === null || (typeof value.initializedAt === "number" && Number.isFinite(value.initializedAt))) &&
    Object.keys(value).length === 2;
}

function isCapCamState(value: unknown): value is CapCamState {
  if (!isPlainRecord(value)) return false;
  const runtime = value.runtime;
  const offscreen = value.offscreen;
  const media = value.media;
  const stream = value.stream;
  return isPlainRecord(runtime) && isStatus(runtime.status, RUNTIME_STATUSES) && Object.keys(runtime).length === 1 &&
    isPlainRecord(offscreen) && isStatus(offscreen.status, OFFSCREEN_STATUSES) && Object.keys(offscreen).length === 1 &&
    isPlainRecord(media) && (media.activeMediaId === null || typeof media.activeMediaId === "string") && Object.keys(media).length === 1 &&
    isPlainRecord(stream) && isStatus(stream.status, STREAM_STATUSES) && Object.keys(stream).length === 1 &&
    isCapCamSettings(value.settings) && Object.keys(value).length === 5;
}

export function isResponseData(type: CommandType, value: unknown): boolean {
  switch (type) {
    case "runtime.getStatus":
      return isCapCamState(value);
    case "runtime.initialize":
    case "runtime.shutdown":
    case "runtime.reset":
    case "runtime.getState":
      return isRuntimeStateSnapshot(value);
    case "runtime.getDiagnostics":
      return isRuntimeDiagnostics(value);
    case "runtime.ping":
      return isRuntimePingResponse(value);
    case "offscreen.initialize":
    case "offscreen.getStatus":
    case "offscreen.shutdown":
      return isOffscreenRuntimeInfo(value);
    case "settings.get":
    case "settings.update":
      return isCapCamSettings(value);
    case "media.register":
    case "media.get":
    case "media.remove":
    case "media.inspect":
      return isMediaRecord(value);
    case "media.list":
      return Array.isArray(value) && value.every(isMediaRecord);
    case "media.clear":
      return isPlainRecord(value) && Object.keys(value).length === 1 &&
        typeof value.removed === "number" && Number.isInteger(value.removed) && value.removed >= 0;
    case "stream.create":
    case "stream.getState":
    case "stream.start":
    case "stream.stop":
    case "stream.restart":
    case "stream.switchSource":
    case "stream.dispose":
      return isStreamInfo(value);
    case "stream.getTrackInfo":
      return isStreamTrackInfo(value);
    case "playback.load":
    case "playback.play":
    case "playback.pause":
    case "playback.stop":
    case "playback.restart":
    case "playback.seek":
    case "playback.setLoop":
    case "playback.setRate":
      return isPlaybackRecord(value);
    case "playback.getState":
    case "playback.dispose":
      return value === null || isPlaybackRecord(value);
    default:
      return false;
  }
}

function isEventPayload(type: EventType, value: unknown): boolean {
  switch (type) {
    case "runtime.stateChanged":
      return isCapCamState(value);
    case "runtime.lifecycleChanged":
      return isRuntimeStateSnapshot(value);
    case "offscreen.statusChanged":
      return isOffscreenRuntimeInfo(value);
    case "settings.changed":
      return isCapCamSettings(value);
    case "media.registered":
    case "media.loading":
    case "media.ready":
    case "media.released": {
      if (!isPlainRecord(value) || !isMediaId(value.mediaId) || !isMediaRecord(value.record)) return false;
      if (value.record.id !== value.mediaId) return false;
      const expectedStatus = type === "media.registered" ? "NEW"
        : type === "media.loading" ? "LOADING"
        : type === "media.ready" ? "READY"
        : "RELEASED";
      return value.record.status === expectedStatus && Object.keys(value).length === 2;
    }
    case "media.failed":
      return isPlainRecord(value) && isMediaId(value.mediaId) &&
        isMediaRecord(value.record) && value.record.id === value.mediaId &&
        value.record.status === "ERROR" && isMediaErrorInfo(value.error) && Object.keys(value).length === 3;
    case "media.removed":
      return isPlainRecord(value) && isMediaId(value.mediaId) && Object.keys(value).length === 1;
    case "stream.stateChanged":
      return isStreamInfo(value);
    default:
      if (!PLAYBACK_EVENT_TYPES.includes(type as PlaybackEventType) || !isPlainRecord(value)) return false;
      return isPlaybackId(value.playbackId) && isMediaId(value.mediaId) &&
        typeof value.timestamp === "number" && Number.isFinite(value.timestamp) &&
        isPlaybackRecord(value.record) && value.record.playbackId === value.playbackId &&
        value.record.mediaId === value.mediaId && Object.keys(value).length === 4 &&
        Object.keys(value).every((key) => ["playbackId", "mediaId", "timestamp", "record"].includes(key));
  }
}

export function isEventEnvelope(value: unknown): value is EventEnvelope {
  return isPlainRecord(value) &&
    value.protocol === PROTOCOL_VERSION &&
    typeof value.type === "string" &&
    EVENT_TYPES.includes(value.type as EventType) &&
    Object.hasOwn(value, "payload") &&
    Object.keys(value).length === 3 &&
    isEventPayload(value.type as EventType, value.payload);
}

