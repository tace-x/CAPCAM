import { describe, expect, it } from "vitest";
import { BackgroundMessageRouter } from "../../src/background/message-router";
import { BackgroundRuntime } from "../../src/background/runtime";
import type { MediaCommandType } from "../../src/background/offscreen-manager";
import type { CommandArguments, CommandResult } from "../../src/messaging/commands";
import { createCommand } from "../../src/messaging/commands";
import { isResponseData, isResponseEnvelope } from "../../src/messaging/protocol";
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

  it("exposes revisioned camera status while the production activation gate stays closed", async () => {
    const runtime = new BackgroundRuntime(offscreen, settings);
    const router = new BackgroundMessageRouter(runtime, "capcam-id", "chrome-extension://capcam-id/");
    const sender = { id: "capcam-id", url: "chrome-extension://capcam-id/popup.html" };

    const statusResponse = await router.handle(createCommand("camera.getStatus"), sender);
    const enableResponse = await router.handle(createCommand("camera.enable"), sender);

    expect(statusResponse.success).toBe(true);
    expect(enableResponse.success).toBe(true);
    if (statusResponse.success) {
      expect(isResponseData("camera.getStatus", statusResponse.data)).toBe(true);
      expect(statusResponse.data).toMatchObject({ status: { state: "BLOCKED_PHASE_06_VERIFICATION" } });
    }
    if (enableResponse.success) {
      expect(isResponseData("camera.enable", enableResponse.data)).toBe(true);
      expect(enableResponse.data).toMatchObject({ status: { state: "BLOCKED_PHASE_06_VERIFICATION", capcamActive: false } });
    }
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
