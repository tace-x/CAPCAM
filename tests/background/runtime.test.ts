import { describe, expect, it } from "vitest";
import type { MediaCommandType, OffscreenService } from "../../src/background/offscreen-manager";
import type { CommandArguments, CommandResult } from "../../src/messaging/commands";
import { BackgroundRuntime } from "../../src/background/runtime";
import type { OffscreenRuntimeInfo } from "../../src/shared/types";
import { DEFAULT_SETTINGS, type CapCamSettings } from "../../src/storage/settings";
import type { StreamInfo } from "../../src/stream/stream-types";

class FakeOffscreenService implements OffscreenService {
  private info: OffscreenRuntimeInfo = { status: "STOPPED", initializedAt: null };
  initializeCalls = 0;

  async initialize(): Promise<OffscreenRuntimeInfo> {
    this.initializeCalls += 1;
    this.info = { status: "READY", initializedAt: Date.now() };
    return { ...this.info };
  }

  async getStatus(): Promise<OffscreenRuntimeInfo> {
    return { ...this.info };
  }

  async shutdown(): Promise<OffscreenRuntimeInfo> {
    this.info = { status: "STOPPED", initializedAt: null };
    return { ...this.info };
  }

  async execute<T extends MediaCommandType>(type: T, ..._args: CommandArguments<T>): Promise<CommandResult<T>> {
    if (type === "stream.getState") {
      const info: StreamInfo = {
        streamId: null,
        sourceMediaId: null,
        state: "IDLE",
        config: null,
        track: null,
        error: null,
        disposed: false,
        changedAt: Date.now(),
      };
      return info as CommandResult<T>;
    }
    throw new Error("Unexpected offscreen command in this runtime lifecycle test.");
  }
}

class FakeSettingsService {
  private settings: CapCamSettings = { ...DEFAULT_SETTINGS };

  async getSettings(): Promise<CapCamSettings> {
    return { ...this.settings };
  }

  async updateSettings(patch: Partial<CapCamSettings>): Promise<CapCamSettings> {
    this.settings = { ...this.settings, ...patch };
    return { ...this.settings };
  }
}

describe("background runtime lifecycle", () => {
  it("initializes service-worker and offscreen runtime state", async () => {
    const offscreen = new FakeOffscreenService();
    const runtime = new BackgroundRuntime(offscreen, new FakeSettingsService());

    await runtime.initialize();
    const state = await runtime.getStatus();

    expect(state.runtime.status).toBe("READY");
    expect(state.offscreen.status).toBe("READY");
    expect(state.settings).toEqual(DEFAULT_SETTINGS);
    expect(offscreen.initializeCalls).toBe(1);
  });

  it("shuts down and reinitializes the offscreen runtime", async () => {
    const offscreen = new FakeOffscreenService();
    const runtime = new BackgroundRuntime(offscreen, new FakeSettingsService());

    await runtime.initialize();
    const stopped = await runtime.shutdown();
    expect(stopped.status).toBe("STOPPED");

    await runtime.initialize();
    const recovered = await runtime.getStatus();
    expect(recovered.runtime.status).toBe("READY");
    expect(recovered.offscreen.status).toBe("READY");
    expect(offscreen.initializeCalls).toBe(2);
  });
});
