import { describe, expect, it } from "vitest";
import { isEventEnvelope } from "../../src/messaging/protocol";
import type { EventEnvelope } from "../../src/messaging/events";
import { RuntimeManager } from "../../src/offscreen/runtime-manager";
import type { MediaRuntime } from "../../src/offscreen/media-runtime";
import { isRuntimeDiagnostics } from "../../src/shared/runtime-types";
import { CapCamError } from "../../src/shared/errors";

type FakeMediaRuntimeOptions = {
  initializeGate?: Promise<void>;
  initializeError?: unknown;
  shutdownError?: unknown;
};

function makeFakeMediaRuntime(options: FakeMediaRuntimeOptions = {}) {
  const calls: string[] = [];
  let playbackState: string | null = null;
  let rendererActive = false;
  let mediaCount = 0;
  let streamCount = 0;
  let playbackCount = 0;
  let initializeError = options.initializeError;
  let shutdownError = options.shutdownError;
  const runtime = {
    mediaEngine: {
      list: () => Array.from({ length: mediaCount }, (_, index) => ({ id: `med_fixture${index}` })),
    },
    playback: {
      getState: () => playbackState === null ? null : { state: playbackState },
      getActiveCount: () => playbackCount,
    },
    streams: {
      getActiveCount: () => streamCount,
      isRendererActive: () => rendererActive,
    },
    async initialize(): Promise<void> {
      calls.push("initialize");
      if (options.initializeGate !== undefined) await options.initializeGate;
      if (initializeError !== undefined) throw initializeError;
    },
    async shutdown(): Promise<void> {
      calls.push("shutdown");
      if (shutdownError !== undefined) throw shutdownError;
    },
  };
  return {
    runtime: runtime as unknown as MediaRuntime,
    calls,
    setInitializeError(error: unknown): void { initializeError = error; },
    setShutdownError(error: unknown): void { shutdownError = error; },
    setDiagnostics(values: { media?: number; playback?: number; streams?: number }): void {
      mediaCount = values.media ?? mediaCount;
      playbackCount = values.playback ?? playbackCount;
      streamCount = values.streams ?? streamCount;
    },
    setActivity(values: { playback?: string | null; renderer?: boolean }): void {
      if (values.playback !== undefined) playbackState = values.playback;
      if (values.renderer !== undefined) rendererActive = values.renderer;
    },
  };
}

function createManager(fake = makeFakeMediaRuntime(), events: EventEnvelope[] = []) {
  let sequence = 0;
  const manager = new RuntimeManager(fake.runtime, {
    now: () => 1_000 + sequence,
    createRuntimeSessionId: () => {
      sequence += 1;
      return `runtime_session${String(sequence).padStart(4, "0")}`;
    },
    publishEvent: (event) => events.push(event),
  });
  return { manager, fake };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}

describe("offscreen RuntimeManager", () => {
  it("deduplicates concurrent initialization and reports ready subsystem diagnostics", async () => {
    const gate = deferred<void>();
    const fake = makeFakeMediaRuntime({ initializeGate: gate.promise });
    const events: EventEnvelope[] = [];
    const { manager } = createManager(fake, events);

    const first = manager.initialize();
    const second = manager.initialize();
    expect(first).toBe(second);
    gate.resolve(undefined);
    const [snapshot, duplicate] = await Promise.all([first, second]);

    expect(snapshot.state).toBe("ready");
    expect(duplicate).toEqual(snapshot);
    expect(fake.calls).toEqual(["initialize"]);
    expect(manager.getOffscreenStatus()).toEqual({ status: "READY", initializedAt: 1_001 });
    const diagnostics = manager.getDiagnostics();
    expect(isRuntimeDiagnostics(diagnostics)).toBe(true);
    expect(diagnostics.subsystems).toEqual({
      mediaEngine: "ready",
      playbackEngine: "ready",
      canvasRenderer: "ready",
      streamManager: "ready",
    });
    expect(events.every(isEventEnvelope)).toBe(true);
    expect(events.map((event) => event.type)).toEqual(["runtime.lifecycleChanged", "runtime.lifecycleChanged"]);
  });

  it("tracks active work and native playback/renderer activity without allowing shutdown races", async () => {
    const { manager, fake } = createManager();
    await manager.initialize();
    fake.setActivity({ playback: "PLAYING" });
    manager.observeSubsystemActivity();
    await Promise.resolve();
    await Promise.resolve();
    expect(manager.getState().state).toBe("active");

    const operation = deferred<string>();
    const running = manager.runSubsystemOperation(() => operation.promise);
    const stopping = manager.shutdown();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(manager.getState().state).toBe("stopping");
    await expect(manager.runSubsystemOperation(() => "late")).rejects.toMatchObject({ code: "RUNTIME_STOPPED" });

    operation.resolve("done");
    await expect(running).resolves.toBe("done");
    expect((await stopping).state).toBe("stopped");
    expect(fake.calls).toEqual(["initialize", "shutdown"]);
  });

  it("makes shutdown idempotent and reset clears only runtime resources while rotating the session", async () => {
    const { manager, fake } = createManager();
    const firstReady = await manager.initialize();
    const firstStop = await manager.shutdown();
    const repeatedStop = await manager.shutdown();

    expect(firstStop.state).toBe("stopped");
    expect(repeatedStop).toEqual(firstStop);
    expect(fake.calls).toEqual(["initialize", "shutdown"]);

    const reset = await manager.reset();
    expect(reset.state).toBe("ready");
    expect(reset.runtimeSessionId).not.toBe(firstReady.runtimeSessionId);
    expect(fake.calls).toEqual(["initialize", "shutdown", "shutdown", "initialize"]);
    expect(manager.getDiagnostics().activeMediaCount).toBe(0);
  });

  it("cleans up partial initialization before error and recovers only through reset", async () => {
    const fake = makeFakeMediaRuntime({ initializeError: new CapCamError("CAPCAM_RUNTIME_ERROR", "test init failure") });
    const { manager } = createManager(fake);

    await expect(manager.initialize()).rejects.toMatchObject({ code: "RUNTIME_INITIALIZATION_FAILED" });
    expect(manager.getState().state).toBe("error");
    expect(manager.getState().lastError?.code).toBe("CAPCAM_RUNTIME_ERROR");
    expect(fake.calls).toEqual(["initialize", "shutdown"]);
    await expect(manager.initialize()).rejects.toMatchObject({ code: "RUNTIME_NOT_READY" });

    const failedSessionId = manager.getState().runtimeSessionId;
    fake.setInitializeError(undefined);
    const recovered = await manager.reset();
    expect(recovered.state).toBe("ready");
    expect(recovered.runtimeSessionId).not.toBe(failedSessionId);
    expect(fake.calls).toEqual(["initialize", "shutdown", "shutdown", "initialize"]);
  });

  it("preserves a usable runtime for ordinary subsystem failures but tears down on catastrophic failure", async () => {
    const { manager, fake } = createManager();
    await manager.initialize();

    await expect(manager.runSubsystemOperation(() => {
      throw new CapCamError("CAPCAM_MEDIA_ERROR", "A local decode failed.");
    })).rejects.toMatchObject({ code: "CAPCAM_MEDIA_ERROR" });
    expect(manager.getState().state).toBe("ready");
    expect(fake.calls).toEqual(["initialize"]);

    await expect(manager.runSubsystemOperation(() => {
      throw new CapCamError("CAPCAM_RUNTIME_ERROR", "Subsystem invariant failed.", { ignoredObject: { value: 1 }, safe: "detail" });
    })).rejects.toMatchObject({ code: "CAPCAM_RUNTIME_ERROR" });
    expect(manager.getState().state).toBe("error");
    expect(manager.getState().lastError).toEqual({
      code: "CAPCAM_RUNTIME_ERROR",
      message: "Subsystem invariant failed.",
      details: { safe: "detail" },
    });
    expect(fake.calls).toEqual(["initialize", "shutdown"]);
  });

  it("rejects missing/stale sessions and keeps diagnostics limited to serializable snapshots", async () => {
    const { manager } = createManager();
    await manager.initialize();
    const sessionId = manager.getState().runtimeSessionId;

    expect(manager.authorizeCommand("media.list")).toMatchObject({ code: "RUNTIME_SESSION_MISMATCH" });
    expect(manager.authorizeCommand("media.list", "runtime_stale0001")).toMatchObject({ code: "RUNTIME_SESSION_MISMATCH" });
    expect(manager.authorizeCommand("media.list", sessionId)).toBeNull();
    expect(manager.authorizeCommand("runtime.getState")).toBeNull();
    expect(manager.getDiagnostics()).not.toHaveProperty("mediaEngine");
    expect(JSON.stringify(manager.getDiagnostics())).not.toMatch(/HTMLVideoElement|MediaStream|HTMLCanvasElement/);
  });
});
