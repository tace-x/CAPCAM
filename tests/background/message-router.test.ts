import { describe, expect, it } from "vitest";
import { BackgroundMessageRouter } from "../../src/background/message-router";
import { BackgroundRuntime } from "../../src/background/runtime";
import type { MediaCommandType } from "../../src/background/offscreen-manager";
import type { CommandArguments, CommandResult } from "../../src/messaging/commands";
import { createCommand } from "../../src/messaging/commands";
import { isResponseEnvelope } from "../../src/messaging/protocol";
import type { OffscreenRuntimeInfo } from "../../src/shared/types";
import { DEFAULT_SETTINGS, type CapCamSettings } from "../../src/storage/settings";

const offscreen = {
  async initialize(): Promise<OffscreenRuntimeInfo> { return { status: "READY", initializedAt: Date.now() }; },
  async getStatus(): Promise<OffscreenRuntimeInfo> { return { status: "READY", initializedAt: Date.now() }; },
  async shutdown(): Promise<OffscreenRuntimeInfo> { return { status: "STOPPED", initializedAt: null }; },
  async execute<T extends MediaCommandType>(_type: T, ..._args: CommandArguments<T>): Promise<CommandResult<T>> {
    throw new Error("Unexpected media command in sender-boundary test.");
  },
};

const settings = {
  async getSettings(): Promise<CapCamSettings> { return { ...DEFAULT_SETTINGS }; },
  async updateSettings(patch: Partial<CapCamSettings>): Promise<CapCamSettings> {
    return { ...DEFAULT_SETTINGS, ...patch };
  },
};

describe("background sender boundary", () => {
  it("rejects page/content-script senders before dispatching commands", async () => {
    const runtime = new BackgroundRuntime(offscreen, settings);
    const router = new BackgroundMessageRouter(runtime, "capcam-id", "chrome-extension://capcam-id/");

    const response = await router.handle(
      createCommand("settings.update", { enabled: true }),
      { id: "capcam-id", url: "https://example.test/", tab: { id: 7 } },
    );

    expect(isResponseEnvelope(response)).toBe(true);
    expect(response.success).toBe(false);
    if (!response.success) expect(response.error?.code).toBe("CAPCAM_PERMISSION_ERROR");
  });

  it("allows only the exact extension camera-test page in the explicitly gated build", async () => {
    const runtime = new BackgroundRuntime(offscreen, settings);
    const testPageUrl = "chrome-extension://capcam-id/tests/webrtc/offscreen-bridge.html";
    const testRouter = new BackgroundMessageRouter(runtime, "capcam-id", "chrome-extension://capcam-id/", {
      cameraTestPageUrl: testPageUrl,
    });
    const pageSender = {
      id: "capcam-id",
      url: testPageUrl,
      tab: { id: 17 },
    };

    const allowed = await testRouter.handle(createCommand("settings.get"), pageSender);
    const wrongPage = await testRouter.handle(createCommand("settings.get"), {
      ...pageSender,
      url: "chrome-extension://capcam-id/tests/webrtc/basic-camera.html",
    });
    const normalRouter = new BackgroundMessageRouter(runtime, "capcam-id", "chrome-extension://capcam-id/");
    const normalBuild = await normalRouter.handle(createCommand("settings.get"), pageSender);

    expect(isResponseEnvelope(allowed)).toBe(true);
    expect(allowed.success).toBe(true);
    expect(wrongPage.success).toBe(false);
    expect(normalBuild.success).toBe(false);
  });
});
