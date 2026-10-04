import { describe, expect, it } from "vitest";
import { BackgroundMessageRouter } from "../../src/background/message-router";
import type { MediaCommandType, OffscreenService } from "../../src/background/offscreen-manager";
import { BackgroundRuntime } from "../../src/background/runtime";
import { createCommand, type CommandArguments, type CommandResult } from "../../src/messaging/commands";
import { isResponseEnvelope } from "../../src/messaging/protocol";
import type { RuntimeDiagnostics, RuntimePingResponse, RuntimeStateSnapshot } from "../../src/shared/runtime-types";
import type { OffscreenRuntimeInfo } from "../../src/shared/types";
import { DEFAULT_SETTINGS, type CapCamSettings } from "../../src/storage/settings";

class FakeRuntimeService implements OffscreenService {
  private state: RuntimeStateSnapshot = {
    runtimeSessionId: "runtime_background0001",
    state: "created",
    changedAt: 1,
    initializedAt: null,
    uptimeMs: null,
    lastError: null,
  };
  initializeCalls = 0;
  settingsReads = 0;

  async initialize(): Promise<OffscreenRuntimeInfo> {
    this.initializeCalls += 1;
    this.state = { ...this.state, state: "ready", initializedAt: 10, changedAt: 10, uptimeMs: 0 };
    return { status: "READY", initializedAt: 10 };
  }

  async getStatus(): Promise<OffscreenRuntimeInfo> {
    return { status: this.state.state === "error" ? "ERROR" : this.state.state === "stopped" ? "STOPPED" : "READY", initializedAt: this.state.initializedAt };
  }

  async shutdown(): Promise<OffscreenRuntimeInfo> {
    this.state = { ...this.state, state: "stopped", initializedAt: null, uptimeMs: null };
    return { status: "STOPPED", initializedAt: null };
  }

  getKnownRuntimeSessionId(): string {
    return this.state.runtimeSessionId;
  }

  async execute<T extends MediaCommandType>(type: T, ..._args: CommandArguments<T>): Promise<CommandResult<T>> {
    if (type === "runtime.initialize") return this.state as CommandResult<T>;
    if (type === "runtime.shutdown") {
      await this.shutdown();
      return this.state as CommandResult<T>;
    }
    if (type === "runtime.reset") {
      this.state = {
        ...this.state,
        runtimeSessionId: "runtime_background0002",
        state: "ready",
        changedAt: 20,
        initializedAt: 20,
        uptimeMs: 0,
        lastError: null,
      };
      return this.state as CommandResult<T>;
    }
    if (type === "runtime.getState") return this.state as CommandResult<T>;
    if (type === "runtime.getDiagnostics") {
      const diagnostics: RuntimeDiagnostics = {
        ...this.state,
        activeMediaCount: 0,
        activePlaybackCount: 0,
        activeStreamCount: 0,
        rendererActive: false,
        subsystems: {
          mediaEngine: "ready",
          playbackEngine: "ready",
          canvasRenderer: "ready",
          streamManager: "ready",
        },
      };
      return diagnostics as CommandResult<T>;
    }
    if (type === "runtime.ping") {
      const ping: RuntimePingResponse = {
        runtimeSessionId: this.state.runtimeSessionId,
        state: this.state.state,
        pongAt: 30,
      };
      return ping as CommandResult<T>;
    }
    throw new Error(`Unexpected fake offscreen command: ${type}`);
  }
}

class FakeSettings {
  settings: CapCamSettings = { ...DEFAULT_SETTINGS };
  reads = 0;

  async getSettings(): Promise<CapCamSettings> {
    this.reads += 1;
    return { ...this.settings };
  }

  async updateSettings(patch: Partial<CapCamSettings>): Promise<CapCamSettings> {
    this.settings = { ...this.settings, ...patch };
    return { ...this.settings };
  }
}

const sender = {
  id: "capcam-test",
  url: "chrome-extension://capcam-test/popup.html",
};

describe("background runtime command routes", () => {
  it("routes lifecycle, state, diagnostics, and ping as validated serializable responses", async () => {
    const offscreen = new FakeRuntimeService();
    const settings = new FakeSettings();
    const runtime = new BackgroundRuntime(offscreen, settings);
    const router = new BackgroundMessageRouter(runtime, "capcam-test", "chrome-extension://capcam-test/");

    const initialize = await router.handle(createCommand("runtime.initialize"), sender);
    expect(isResponseEnvelope(initialize)).toBe(true);
    expect(initialize.success).toBe(true);
    if (!initialize.success) throw new Error("Expected runtime.initialize to succeed.");
    expect(initialize.data).toMatchObject({ state: "ready", runtimeSessionId: "runtime_background0001" });
    expect(initialize.runtimeSessionId).toBe("runtime_background0001");

    const state = await router.handle(createCommand("runtime.getState"), sender);
    const diagnostics = await router.handle(createCommand("runtime.getDiagnostics"), sender);
    const ping = await router.handle(createCommand("runtime.ping"), sender);
    expect(state.success).toBe(true);
    expect(diagnostics.success).toBe(true);
    expect(ping.success).toBe(true);
    if (diagnostics.success) expect(diagnostics.data).toMatchObject({ activeStreamCount: 0, rendererActive: false });
    if (ping.success) expect(ping.data).toMatchObject({ state: "ready", pongAt: 30 });

    const settingsReadsBeforeReset = settings.reads;
    const reset = await router.handle(createCommand("runtime.reset"), sender);
    expect(reset.success).toBe(true);
    if (reset.success) expect(reset.data).toMatchObject({ state: "ready", runtimeSessionId: "runtime_background0002" });
    expect(settings.reads).toBe(settingsReadsBeforeReset);

    const shutdown = await router.handle(createCommand("runtime.shutdown"), sender);
    expect(shutdown.success).toBe(true);
    if (shutdown.success) expect(shutdown.data).toMatchObject({ state: "stopped" });
    expect(offscreen.initializeCalls).toBe(1);
  });
});
