import { describe, expect, it, vi } from "vitest";
import { CapCamError } from "../../src/shared/errors";
import { createLogger } from "../../src/shared/logger";
import { serializeProtocolError } from "../../src/messaging/protocol";
import { CommandRouter } from "../../src/messaging/router";
import { MessagingClient } from "../../src/messaging/client";
import { createEvent } from "../../src/messaging/events";
import { MediaIngestClient } from "../../src/media/media-ingest-client";
import type { MediaTransferStore } from "../../src/media/media-transfer-store";
import type { MediaRecord } from "../../src/media/media-types";
import type { RuntimeStateSnapshot } from "../../src/shared/runtime-types";

class MemoryTransferStore implements MediaTransferStore {
  private readonly files = new Map<string, File>();
  private counter = 0;

  async stage(file: File): Promise<string> {
    this.counter += 1;
    const transferId = `transfer_test-${String(this.counter).padStart(8, "0")}`;
    this.files.set(transferId, file);
    return transferId;
  }

  async take(transferId: string): Promise<File> {
    const file = this.files.get(transferId);
    this.files.delete(transferId);
    if (file === undefined) throw new Error("Staged file not found");
    return file;
  }

  async delete(transferId: string): Promise<void> {
    this.files.delete(transferId);
  }

  async clearExpired(): Promise<number> {
    return 0;
  }
}

function mockMediaRecord(id: string): MediaRecord {
  return {
    id,
    name: `${id}.png`,
    kind: "image",
    mimeType: "image/png",
    size: 100,
    width: 100,
    height: 100,
    aspectRatio: 1,
    duration: null,
    sourceUrl: null,
    createdAt: Date.now(),
    status: "READY",
    capabilities: { canDecode: true, canSeek: false, supportsAudio: false },
  };
}

describe("Structured Protocol Error Serialization & Session Resync", () => {
  it("1 & 2 & 3: correctly serializes CapCamError, standard Error, plain objects, and strings without producing [object Object]", () => {
    // CapCamError with metadata
    const capcamError = new CapCamError("RUNTIME_SESSION_MISMATCH", "The request belongs to a different runtime session.", {
      command: "media.register",
      expectedRuntimeSessionId: "runtime_active-001",
      receivedRuntimeSessionId: "runtime_stale-999",
      retryCount: 1,
    });

    const serializedCapcam = serializeProtocolError(capcamError);
    expect(serializedCapcam.code).toBe("RUNTIME_SESSION_MISMATCH");
    expect(serializedCapcam.message).toBe("The request belongs to a different runtime session.");
    expect(serializedCapcam.command).toBe("media.register");
    expect(serializedCapcam.expectedRuntimeSessionId).toBe("runtime_active-001");
    expect(serializedCapcam.actualRuntimeSessionId).toBe("runtime_stale-999");
    expect(serializedCapcam.details).toEqual({
      command: "media.register",
      expectedRuntimeSessionId: "runtime_active-001",
      receivedRuntimeSessionId: "runtime_stale-999",
      retryCount: 1,
    });

    // Standard Error
    const standardError = new Error("Generic failure message");
    const serializedStandard = serializeProtocolError(standardError, { command: "stream.start" });
    expect(serializedStandard.code).toBe("CAPCAM_RUNTIME_ERROR");
    expect(serializedStandard.message).toBe("Generic failure message");
    expect(serializedStandard.command).toBe("stream.start");

    // Plain Object
    const plainObjError = {
      code: "UNKNOWN_COMMAND",
      message: "Command not found",
      details: { attempted: "foo.bar" },
    };
    const serializedPlain = serializeProtocolError(plainObjError);
    expect(serializedPlain.code).toBe("UNKNOWN_COMMAND");
    expect(serializedPlain.message).toBe("Command not found");
    expect(serializedPlain.details).toEqual({ attempted: "foo.bar" });

    // String error
    const serializedString = serializeProtocolError("Raw error string");
    expect(serializedString.code).toBe("CAPCAM_RUNTIME_ERROR");
    expect(serializedString.message).toBe("Raw error string");

    // Null/undefined error
    const serializedNull = serializeProtocolError(null);
    expect(serializedNull.code).toBe("CAPCAM_RUNTIME_ERROR");
    expect(serializedNull.message).toBe("An unexpected CapCam error occurred.");

    // Logger formatting test: Ensure no '[object Object]' is produced
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const protocolLogger = createLogger("Protocol");
    protocolLogger.warn("Command handler returned a structured error.", serializedCapcam);

    expect(warnSpy).toHaveBeenCalled();
    const loggedArgs = warnSpy.mock.calls[0];
    expect(loggedArgs[0]).toBe("[CapCam][Protocol]");
    expect(loggedArgs[1]).toBe("Command handler returned a structured error.");
    expect(loggedArgs[2]).toBe(serializedCapcam);
    expect(String(loggedArgs[1])).not.toContain("[object Object]");
    expect(JSON.stringify(loggedArgs[2])).toContain("RUNTIME_SESSION_MISMATCH");
    warnSpy.mockRestore();
  });

  it("4 & 8 & 9: client with stale session automatically resyncs and performs one-time retry", async () => {
    let currentSession = "runtime_session-gen-0001";
    let mediaRegisterAttempts = 0;

    const router = new CommandRouter({
      authorize: (command) => {
        if (command.type === "runtime.getState") return null;
        if (command.runtimeSessionId !== currentSession) {
          return new CapCamError("RUNTIME_SESSION_MISMATCH", "The request belongs to a different runtime session.", {
            command: command.type,
            expectedRuntimeSessionId: currentSession,
            receivedRuntimeSessionId: command.runtimeSessionId ?? null,
          });
        }
        return null;
      },
      getRuntimeSessionId: () => currentSession,
    });

    router.register("runtime.getState", () => ({
      runtimeSessionId: currentSession,
      state: "ready",
      changedAt: Date.now(),
      initializedAt: Date.now(),
      uptimeMs: 100,
      lastError: null,
    }));

    router.register("media.get", (payload) => {
      mediaRegisterAttempts += 1;
      return mockMediaRecord(payload.mediaId);
    });

    const client = new MessagingClient({
      sendMessage: (msg) => router.handle(msg),
    });

    // Client starts with a stale session
    client.setKnownRuntimeSessionId("runtime_session-stale-9999");
    expect(client.getKnownRuntimeSessionId()).toBe("runtime_session-stale-9999");

    // Sending a command should trigger auto-resync:
    // 1st attempt fails with RUNTIME_SESSION_MISMATCH
    // client queries runtime.getState to fetch "runtime_session-gen-0001"
    // 2nd attempt succeeds with "runtime_session-gen-0001"
    const result = await client.send("media.get", { mediaId: "med_test-00000001" });
    expect(result.id).toBe("med_test-00000001");
    expect(mediaRegisterAttempts).toBe(1);
    expect(client.getKnownRuntimeSessionId()).toBe("runtime_session-gen-0001");
  });

  it("10: prevents infinite retry loops when retry also fails with mismatch or error", async () => {
    const router = new CommandRouter({
      authorize: (command) => {
        if (command.type === "runtime.getState") return null;
        // Always fail authorization
        return new CapCamError("RUNTIME_SESSION_MISMATCH", "Persistent session mismatch.", {
          command: command.type,
          expectedRuntimeSessionId: "runtime_session-always-different",
          receivedRuntimeSessionId: command.runtimeSessionId ?? null,
        });
      },
      getRuntimeSessionId: () => "runtime_session-always-different",
    });

    let getStateCalls = 0;
    router.register("runtime.getState", () => {
      getStateCalls += 1;
      return {
        runtimeSessionId: "runtime_session-gen-xxxx",
        state: "ready",
        changedAt: Date.now(),
        initializedAt: Date.now(),
        uptimeMs: 100,
        lastError: null,
      };
    });

    router.register("media.get", (payload) => mockMediaRecord(payload.mediaId));

    const client = new MessagingClient({
      sendMessage: (msg) => router.handle(msg),
    });

    await expect(client.send("media.get", { mediaId: "med_fail-00000001" })).rejects.toMatchObject({
      code: "RUNTIME_SESSION_MISMATCH",
      message: "Persistent session mismatch.",
    });

    // Exactly 1 resync getState call, never looped
    expect(getStateCalls).toBe(1);
  });

  it("5 & 7 & 11 & 12: offscreen restart rotates session, client updates via event or auto-resync and upload succeeds", async () => {
    let currentSession = "runtime_session-boot-0001";
    const store = new MemoryTransferStore();

    const router = new CommandRouter({
      authorize: (command) => {
        if (command.type === "runtime.getState" || command.type === "runtime.initialize") return null;
        if (command.runtimeSessionId !== currentSession) {
          return new CapCamError("RUNTIME_SESSION_MISMATCH", "The request belongs to a different runtime session.", {
            command: command.type,
            expectedRuntimeSessionId: currentSession,
            receivedRuntimeSessionId: command.runtimeSessionId ?? null,
          });
        }
        return null;
      },
      getRuntimeSessionId: () => currentSession,
    });

    router.register("runtime.getState", () => ({
      runtimeSessionId: currentSession,
      state: "ready",
      changedAt: Date.now(),
      initializedAt: Date.now(),
      uptimeMs: 100,
      lastError: null,
    }));

    router.register("media.register", async (payload) => {
      const file = await store.take(payload.transferId);
      return {
        id: "med_uploaded-0001",
        name: file.name,
        kind: "image",
        mimeType: file.type || "image/png",
        size: file.size,
        width: 640,
        height: 480,
        aspectRatio: 640 / 480,
        duration: null,
        sourceUrl: null,
        createdAt: Date.now(),
        status: "READY",
        capabilities: { canDecode: true, canSeek: false, supportsAudio: false },
      };
    });

    const listeners: Array<(msg: unknown, sender: { id: string; url: string }) => void> = [];
    const eventSource = {
      extensionId: "ext-test",
      backgroundUrl: "background.js",
      addListener: (l: (msg: unknown, sender: { id: string; url: string }) => void) => listeners.push(l),
      removeListener: (l: (msg: unknown, sender: { id: string; url: string }) => void) => {
        const idx = listeners.indexOf(l);
        if (idx >= 0) listeners.splice(idx, 1);
      },
    };

    const client = new MessagingClient(
      { sendMessage: (msg) => router.handle(msg) },
      eventSource,
    );

    // Subscribe to events
    const unsub = client.subscribeEvents(() => undefined);

    const ingestClient = new MediaIngestClient(client, store);

    // Initial upload works
    const file1 = new File(["test-image-bytes"], "photo1.png", { type: "image/png" });
    const record1 = await ingestClient.ingest(file1);
    expect(record1.status).toBe("READY");
    expect(client.getKnownRuntimeSessionId()).toBe("runtime_session-boot-0001");

    // Simulate offscreen restart: session rotates to session_boot_2
    currentSession = "runtime_session-boot-0002";

    // Simulate offscreen lifecycleChanged event broadcast
    const snapshot: RuntimeStateSnapshot = {
      runtimeSessionId: "runtime_session-boot-0002",
      state: "ready",
      changedAt: Date.now(),
      initializedAt: Date.now(),
      uptimeMs: 0,
      lastError: null,
    };
    const lifecycleEvent = createEvent("runtime.lifecycleChanged", snapshot);
    for (const listener of listeners) {
      listener(lifecycleEvent, { id: "ext-test", url: "background.js" });
    }

    // Client session was updated by the event listener
    expect(client.getKnownRuntimeSessionId()).toBe("runtime_session-boot-0002");

    // Another upload succeeds on the new session
    const file2 = new File(["test-image-bytes-2"], "photo2.png", { type: "image/png" });
    const record2 = await ingestClient.ingest(file2);
    expect(record2.status).toBe("READY");
    expect(client.getKnownRuntimeSessionId()).toBe("runtime_session-boot-0002");

    unsub();
  });
});
