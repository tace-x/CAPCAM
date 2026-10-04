import { describe, expect, it } from "vitest";
import {
  isOffscreenStreamBridgeRequest,
  isOffscreenStreamBridgeResponse,
  OFFSCREEN_STREAM_BRIDGE_PROTOCOL,
} from "../../src/shared/camera-test-bridge";

describe("Phase 06 test-only stream bridge envelope", () => {
  it("accepts a versioned request with an opaque request ID", () => {
    expect(isOffscreenStreamBridgeRequest({
      protocol: OFFSCREEN_STREAM_BRIDGE_PROTOCOL,
      type: "get-active-stream",
      requestId: "550e8400-e29b-41d4-a716-446655440000",
    })).toBe(true);
  });

  it("rejects unsupported versions, malformed IDs, and unexpected request properties", () => {
    expect(isOffscreenStreamBridgeRequest({ protocol: 2, type: "get-active-stream", requestId: "request_000001" })).toBe(false);
    expect(isOffscreenStreamBridgeRequest({ protocol: 1, type: "get-active-stream", requestId: "short" })).toBe(false);
    expect(isOffscreenStreamBridgeRequest({ protocol: 1, type: "get-active-stream", requestId: "request_000001", stream: {} })).toBe(false);
  });

  it("accepts a structured error response without browser media data", () => {
    expect(isOffscreenStreamBridgeResponse({
      protocol: 1,
      type: "error",
      requestId: "request_000001",
      message: "No active stream.",
    })).toBe(true);
  });

  it("shape-checks a stream response but leaves native MediaStream verification to the browser page", () => {
    expect(isOffscreenStreamBridgeResponse({
      protocol: 1,
      type: "active-stream",
      requestId: "request_000001",
      stream: {},
    })).toBe(true);
    expect(isOffscreenStreamBridgeResponse({
      protocol: 1,
      type: "active-stream",
      requestId: "request_000001",
      stream: "not a stream",
    })).toBe(false);
  });
});
