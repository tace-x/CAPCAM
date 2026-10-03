import { describe, expect, it } from "vitest";
import { OffscreenManager, type OffscreenPlatform } from "../../src/background/offscreen-manager";
import type { CommandEnvelope } from "../../src/messaging/commands";
import { CommandRouter } from "../../src/messaging/router";
import type { MediaRecord } from "../../src/media/media-types";
import type { MediaRuntime } from "../../src/offscreen/media-runtime";
import { RuntimeManager } from "../../src/offscreen/runtime-manager";
import type { RuntimeStateSnapshot } from "../../src/shared/runtime-types";

function createMediaRecord(id: string): MediaRecord {
  return {
    id,
    name: `${id}.png`,
    kind: "image",
    mimeType: "image/png",
    size: 1,
    width: 16,
    height: 9,
    aspectRatio: 16 / 9,
    duration: null,
    sourceUrl: null,
    createdAt: 1,
    status: "READY",
    capabilities: { canDecode: true, canSeek: false, supportsAudio: false },
  };
}

function createEndpoint(documentSequence: number, platform: FakeOffscreenPlatform): {
  manager: RuntimeManager;
  router: CommandRouter;
} {
  const mediaRuntime = {
    mediaEngine: { list: () => [] },
    playback: { getState: () => null, getActiveCount: () => 0 },
    streams: { getActiveCount: () => 0, isRendererActive: () => false },
    async initialize(): Promise<void> { return undefined; },
    async shutdown(): Promise<void> { return undefined; },
  } as unknown as MediaRuntime;
  let sessionSequence = 0;
  const manager = new RuntimeManager(mediaRuntime, {
    createRuntimeSessionId: () => {
      sessionSequence += 1;
      return `runtime_doc${String(documentSequence).padStart(4, "0")}session${String(sessionSequence).padStart(4, "0")}`;
    },
  });
  const router = new CommandRouter({
    authorize: (command) => manager.authorizeCommand(command.type, command.runtimeSessionId),
    getRuntimeSessionId: () => manager.getState().runtimeSessionId,
  });
  router.register("runtime.initialize", () => manager.initialize());
  router.register("runtime.shutdown", () => manager.shutdown());
  router.register("runtime.reset", () => manager.reset());
  router.register("runtime.getState", () => manager.getState());
  router.register("runtime.getDiagnostics", () => manager.getDiagnostics());
  router.register("runtime.ping", () => manager.ping());
  router.register("media.get", async (payload) => {
    const delay = platform.delaysByMediaId.get(payload.mediaId) ?? 0;
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    return createMediaRecord(payload.mediaId);
  });
  router.register("media.list", () => []);
  return { manager, router };
}

class FakeOffscreenPlatform implements OffscreenPlatform {
  exists = false;
  createCalls = 0;
  closeCalls = 0;
  failNextMessage = false;
  delayNextMessageMs = 0;
  alterNextResponseRequestId = false;
  readonly delaysByMediaId = new Map<string, number>();
  readonly requests: CommandEnvelope[] = [];
  readonly responses: Array<{ requestId: string; responseRequestId: string; success: boolean }> = [];
  private documentSequence = 0;
  private endpoint: ReturnType<typeof createEndpoint> | null = null;

  async hasDocument(): Promise<boolean> {
    return this.exists;
  }

  async createDocument(): Promise<void> {
    this.createCalls += 1;
    this.documentSequence += 1;
    this.exists = true;
    this.endpoint = createEndpoint(this.documentSequence, this);
    await this.endpoint.manager.initialize();
  }

  async closeDocument(): Promise<void> {
    this.closeCalls += 1;
    this.exists = false;
    this.endpoint = null;
  }

  async sendMessage(message: unknown): Promise<unknown> {
    const request = message as CommandEnvelope;
    this.requests.push(request);
    if (this.failNextMessage) {
      this.failNextMessage = false;
      throw new Error("Simulated lost offscreen message channel.");
    }
    let delay = this.delayNextMessageMs;
    this.delayNextMessageMs = 0;
    if (request.type === "media.get" && "payload" in request && request.payload !== undefined) {
      delay = this.delaysByMediaId.get(request.payload.mediaId) ?? delay;
    }
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    if (this.endpoint === null) throw new Error("No offscreen document is active.");
    let response = await this.endpoint.router.handle(message);
    if (this.alterNextResponseRequestId) {
      this.alterNextResponseRequestId = false;
      response = { ...response, requestId: "req_wrong_response0001" };
    }
    this.responses.push({
      requestId: request.requestId,
      responseRequestId: typeof response === "object" && response !== null && "requestId" in response
        ? String(response.requestId)
        : "missing",
      success: typeof response === "object" && response !== null && "success" in response && response.success === true,
    });
    return response;
  }

  async recreateDocument(): Promise<void> {
    await this.closeDocument();
    await this.createDocument();
  }

  currentRuntimeState(): RuntimeStateSnapshot | null {
    return this.endpoint?.manager.getState() ?? null;
  }

  async stopRuntimeInPlace(): Promise<void> {
    await this.endpoint?.manager.shutdown();
  }
}

describe("offscreen document and protocol manager", () => {
  it("centralizes document creation, initialization, status checks, and shutdown", async () => {
    const platform = new FakeOffscreenPlatform();
    const manager = new OffscreenManager(platform);

    expect((await manager.initialize()).status).toBe("READY");
    const firstSession = manager.getKnownRuntimeSessionId();
    expect(firstSession).toMatch(/^runtime_/);
    expect(await manager.initialize()).toEqual({ status: "READY", initializedAt: expect.any(Number) });
    expect(platform.createCalls).toBe(1);
    expect((await manager.getStatus()).status).toBe("READY");

    expect(await manager.shutdown()).toEqual({ status: "STOPPED", initializedAt: null });
    expect(platform.closeCalls).toBe(1);
    expect(await platform.hasDocument()).toBe(false);
    expect(manager.getKnownRuntimeSessionId()).toBeNull();
  });

  it("rediscovers a live offscreen document after coordinator memory is recreated", async () => {
    const platform = new FakeOffscreenPlatform();
    const firstCoordinator = new OffscreenManager(platform);
    await firstCoordinator.initialize();
    const existingSession = firstCoordinator.getKnownRuntimeSessionId();

    const restartedCoordinator = new OffscreenManager(platform);
    expect((await restartedCoordinator.initialize()).status).toBe("READY");

    expect(platform.createCalls).toBe(1);
    expect(restartedCoordinator.getKnownRuntimeSessionId()).toBe(existingSession);
    expect((await restartedCoordinator.execute("runtime.getState")).runtimeSessionId).toBe(existingSession);
  });

  it("correlates concurrent requests by unique request ID even when responses arrive out of order", async () => {
    const platform = new FakeOffscreenPlatform();
    const manager = new OffscreenManager(platform);
    await manager.initialize();
    platform.requests.length = 0;
    platform.responses.length = 0;
    platform.delaysByMediaId.set("med_alpha0001", 20);
    platform.delaysByMediaId.set("med_bravo0002", 1);

    const [alpha, bravo] = await Promise.all([
      manager.execute("media.get", { mediaId: "med_alpha0001" }),
      manager.execute("media.get", { mediaId: "med_bravo0002" }),
    ]);

    expect(alpha.id).toBe("med_alpha0001");
    expect(bravo.id).toBe("med_bravo0002");
    expect(platform.requests).toHaveLength(2);
    expect(new Set(platform.requests.map((request) => request.requestId)).size).toBe(2);
    expect(platform.responses).toHaveLength(2);
    expect(platform.responses.every((pair) => pair.requestId === pair.responseRequestId && pair.success)).toBe(true);
    expect(platform.responses[0]?.requestId).not.toBe(platform.responses[1]?.requestId);
  });

  it("reconciles a recreated document's stale session and retries only after authorization rejects the old request", async () => {
    const platform = new FakeOffscreenPlatform();
    const manager = new OffscreenManager(platform);
    await manager.initialize();
    const staleSession = manager.getKnownRuntimeSessionId();
    await platform.recreateDocument();
    const recreatedSession = platform.currentRuntimeState()?.runtimeSessionId;
    expect(recreatedSession).not.toBe(staleSession);
    platform.requests.length = 0;

    const result = await manager.execute("media.get", { mediaId: "med_alpha0001" });

    expect(result.id).toBe("med_alpha0001");
    const attempts = platform.requests.filter((request) => request.type === "media.get");
    expect(attempts).toHaveLength(2);
    expect(attempts[0]?.runtimeSessionId).toBe(staleSession);
    expect(attempts[1]?.runtimeSessionId).toBe(recreatedSession);
    expect(manager.getKnownRuntimeSessionId()).toBe(recreatedSession);
    expect(platform.closeCalls).toBe(1); // only the explicit simulated recreation
  });

  it("recovers a stopped runtime in place and rotates the runtime session on reset", async () => {
    const platform = new FakeOffscreenPlatform();
    const manager = new OffscreenManager(platform);
    await manager.initialize();
    const firstSession = manager.getKnownRuntimeSessionId();

    const reset = await manager.execute("runtime.reset");
    expect(reset.state).toBe("ready");
    expect(reset.runtimeSessionId).not.toBe(firstSession);
    expect(await platform.hasDocument()).toBe(true);

    const resetSession = reset.runtimeSessionId;
    await platform.stopRuntimeInPlace();
    const recovered = await manager.execute("media.get", { mediaId: "med_bravo0002" });
    expect(recovered.id).toBe("med_bravo0002");
    expect(manager.getKnownRuntimeSessionId()).not.toBe(resetSession);
  });

  it("returns a distinct bounded timeout without treating it as proof of a crash", async () => {
    const platform = new FakeOffscreenPlatform();
    const manager = new OffscreenManager(platform, { requestTimeoutMs: 5 });
    await manager.initialize();
    const sessionId = manager.getKnownRuntimeSessionId();
    platform.delayNextMessageMs = 30;

    await expect(manager.execute("media.get", { mediaId: "med_alpha0001" })).rejects.toMatchObject({
      code: "RUNTIME_REQUEST_TIMEOUT",
      metadata: { command: "media.get", timeoutMs: 5 },
    });
    await new Promise((resolve) => setTimeout(resolve, 35));

    expect(platform.closeCalls).toBe(0);
    expect(platform.createCalls).toBe(1);
    expect(manager.getKnownRuntimeSessionId()).toBe(sessionId);
  });

  it("recreates after a message-channel failure but does not loop on recovery", async () => {
    const platform = new FakeOffscreenPlatform();
    const manager = new OffscreenManager(platform);
    await manager.initialize();
    platform.failNextMessage = true;

    const result = await manager.execute("media.get", { mediaId: "med_alpha0001" });

    expect(result.id).toBe("med_alpha0001");
    expect(platform.closeCalls).toBe(1);
    expect(platform.createCalls).toBe(2);
    expect(platform.requests.filter((request) => request.type === "media.get")).toHaveLength(2);
  });

  it("rejects a response with the wrong request ID instead of misrouting it", async () => {
    const platform = new FakeOffscreenPlatform();
    const manager = new OffscreenManager(platform);
    await manager.initialize();
    platform.alterNextResponseRequestId = true;

    await expect(manager.execute("media.get", { mediaId: "med_alpha0001" })).rejects.toMatchObject({
      code: "CAPCAM_PROTOCOL_ERROR",
    });
    expect(platform.closeCalls).toBe(0);
  });
});
