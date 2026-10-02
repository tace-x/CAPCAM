import { PROTOCOL_VERSION } from "../shared/constants";
import { CapCamError, isCapCamErrorCode, toErrorDetail, type CapCamErrorCode } from "../shared/errors";
import type { CapCamState, OffscreenRuntimeInfo, OffscreenStatus, RuntimeStatus, StreamStatus } from "../shared/types";
import { isCapCamSettings, isSettingsPatch } from "../storage/settings";
import { isMediaErrorInfo, isMediaId, isMediaRecord, isTransferId } from "../media/media-validation";
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
];
const EVENT_TYPES: readonly EventType[] = [
  "runtime.stateChanged",
  "offscreen.statusChanged",
  "settings.changed",
  "media.registered",
  "media.loading",
  "media.ready",
  "media.failed",
  "media.removed",
  "media.released",
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
  ];
  const allowedKeys = payloadCommands.includes(type)
    ? ["protocol", "requestId", "type", "payload"]
    : ["protocol", "requestId", "type"];
  if (Object.keys(value).some((key) => !allowedKeys.includes(key))) {
    return { ok: false, requestId, error: makeProtocolError("Command envelope contains unsupported fields.") };
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
    default:
      validPayload = !Object.hasOwn(value, "payload");
  }
  if (!validPayload) {
    return { ok: false, requestId, error: makeProtocolError("Command payload is invalid or unsupported.") };
  }

  return { ok: true, command: value as unknown as CommandEnvelope };
}

export function createSuccessResponse<T>(requestId: string, data: T): ResponseEnvelope<T> {
  return { protocol: PROTOCOL_VERSION, requestId, success: true, data };
}

export function createErrorResponse(requestId: string, error: CapCamError): ResponseEnvelope<never> {
  return { protocol: PROTOCOL_VERSION, requestId, success: false, error: toErrorDetail(error) };
}

function isResponseError(value: unknown): value is ResponseError {
  if (!isPlainRecord(value)) return false;
  if (!isCapCamErrorCode(value.code) || typeof value.message !== "string" || value.message.length === 0) return false;
  if (Object.hasOwn(value, "metadata") && !isPlainRecord(value.metadata)) return false;
  return Object.keys(value).every((key) => ["code", "message", "metadata"].includes(key));
}

export function isResponseEnvelope(value: unknown): value is ResponseEnvelope {
  if (!isPlainRecord(value) || value.protocol !== PROTOCOL_VERSION || !isRequestId(value.requestId)) return false;
  if (value.success === true) {
    return Object.hasOwn(value, "data") && !Object.hasOwn(value, "error") &&
      Object.keys(value).every((key) => ["protocol", "requestId", "success", "data"].includes(key));
  }
  if (value.success === false) {
    return Object.hasOwn(value, "error") && !Object.hasOwn(value, "data") && isResponseError(value.error) &&
      Object.keys(value).every((key) => ["protocol", "requestId", "success", "error"].includes(key));
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
    default:
      return false;
  }
}

function isEventPayload(type: EventType, value: unknown): boolean {
  switch (type) {
    case "runtime.stateChanged":
      return isCapCamState(value);
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
    default:
      return false;
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

