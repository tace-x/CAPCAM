/**
 * Test-build-only BroadcastChannel contract for the Phase 06 boundary experiment.
 * These messages are not Chrome runtime messages, persistent settings, or production API.
 * A normal extension build never installs the offscreen listener.
 */
export const OFFSCREEN_STREAM_BRIDGE_CHANNEL = "capcam.phase06.offscreen-stream.v1";
export const OFFSCREEN_STREAM_BRIDGE_PROTOCOL = 1 as const;

export interface OffscreenStreamBridgeRequest {
  protocol: typeof OFFSCREEN_STREAM_BRIDGE_PROTOCOL;
  type: "get-active-stream";
  requestId: string;
}

export type OffscreenStreamBridgeResponse =
  | {
      protocol: typeof OFFSCREEN_STREAM_BRIDGE_PROTOCOL;
      type: "active-stream";
      requestId: string;
      stream: MediaStream;
    }
  | {
      protocol: typeof OFFSCREEN_STREAM_BRIDGE_PROTOCOL;
      type: "error";
      requestId: string;
      message: string;
    };

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function isRequestId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{8,100}$/.test(value);
}

export function isOffscreenStreamBridgeRequest(value: unknown): value is OffscreenStreamBridgeRequest {
  if (!isPlainRecord(value)) return false;
  return value.protocol === OFFSCREEN_STREAM_BRIDGE_PROTOCOL &&
    value.type === "get-active-stream" &&
    isRequestId(value.requestId) &&
    hasExactKeys(value, ["protocol", "type", "requestId"]);
}

export function isOffscreenStreamBridgeResponse(value: unknown): value is OffscreenStreamBridgeResponse {
  if (!isPlainRecord(value) || value.protocol !== OFFSCREEN_STREAM_BRIDGE_PROTOCOL || !isRequestId(value.requestId)) return false;
  if (value.type === "active-stream") {
    return hasExactKeys(value, ["protocol", "type", "requestId", "stream"]) &&
      typeof value.stream === "object" && value.stream !== null;
  }
  if (value.type === "error") {
    return hasExactKeys(value, ["protocol", "type", "requestId", "message"]) &&
      typeof value.message === "string" && value.message.length <= 400;
  }
  return false;
}
