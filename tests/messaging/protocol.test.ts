import { describe, expect, it } from "vitest";
import { CapCamError } from "../../src/shared/errors";
import { createCommand, generateRequestId } from "../../src/messaging/commands";
import { CommandRouter } from "../../src/messaging/router";
import {
  createErrorResponse,
  createSuccessResponse,
  isEventEnvelope,
  isResponseEnvelope,
  validateCommand,
} from "../../src/messaging/protocol";
import { createEvent } from "../../src/messaging/events";
import { DEFAULT_SETTINGS } from "../../src/storage/settings";

describe("internal messaging protocol", () => {
  it("generates distinct request IDs", () => {
    const first = generateRequestId();
    const second = generateRequestId();
    expect(first).not.toBe(second);
    expect(first.length).toBeGreaterThan(0);
  });

  it("accepts supported commands and rejects unsupported protocol, type, payload, and fields", () => {
    const valid = createCommand("settings.update", { fps: 24, fitMode: "cover" });
    expect(validateCommand(valid).ok).toBe(true);

    expect(validateCommand({ ...valid, protocol: 99 }).ok).toBe(false);
    expect(validateCommand({ ...valid, type: "camera.intercept" }).ok).toBe(false);
    expect(validateCommand({ ...valid, payload: { fps: 240 } }).ok).toBe(false);
    expect(validateCommand({ ...valid, extra: true }).ok).toBe(false);
  });

  it("validates successful and structured error responses", () => {
    const success = createSuccessResponse("request-1", { ...DEFAULT_SETTINGS });
    const failure = createErrorResponse("request-2", new CapCamError("CAPCAM_PROTOCOL_ERROR", "Invalid command."));
    expect(isResponseEnvelope(success)).toBe(true);
    expect(isResponseEnvelope(failure)).toBe(true);
    expect(isResponseEnvelope({ ...success, error: { code: "CAPCAM_RUNTIME_ERROR", message: "bad" } })).toBe(false);
    expect(isResponseEnvelope({ ...failure, requestId: "" })).toBe(false);
  });

  it("validates typed events and returns a structured error for unhandled commands", async () => {
    const event = createEvent("settings.changed", { ...DEFAULT_SETTINGS });
    expect(isEventEnvelope(event)).toBe(true);
    expect(isEventEnvelope({ ...event, payload: { ...DEFAULT_SETTINGS, fps: 0 } })).toBe(false);

    const response = await new CommandRouter().handle(createCommand("runtime.getStatus"));
    expect(isResponseEnvelope(response)).toBe(true);
    expect(response.success).toBe(false);
    if (!response.success) expect(response.error?.code).toBe("CAPCAM_PROTOCOL_ERROR");
  });
});
