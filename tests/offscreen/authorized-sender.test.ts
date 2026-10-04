import { describe, expect, it } from "vitest";
import { isAuthorizedOffscreenCommandSender } from "../../src/offscreen/authorized-sender";

describe("isAuthorizedOffscreenCommandSender boundary validation", () => {
  const extensionId = "capcam-ext-id";
  const backgroundUrl = `chrome-extension://${extensionId}/background.js`;
  const popupUrl = `chrome-extension://${extensionId}/popup.html`;
  const devTestUrl = `chrome-extension://${extensionId}/developer-test.html`;
  const cameraTestUrl = `chrome-extension://${extensionId}/tests/webrtc/offscreen-bridge.html`;

  it("authorizes service worker sender in real Chrome (url is undefined)", () => {
    const swSender = {
      id: extensionId,
      tab: undefined,
      url: undefined,
    };
    expect(isAuthorizedOffscreenCommandSender(swSender, extensionId, backgroundUrl)).toBe(true);
  });

  it("authorizes service worker sender in test harness (url equals backgroundUrl)", () => {
    const swSender = {
      id: extensionId,
      tab: undefined,
      url: backgroundUrl,
    };
    expect(isAuthorizedOffscreenCommandSender(swSender, extensionId, backgroundUrl)).toBe(true);
  });

  it("rejects extension UI pages (popup.html) to prevent command context collision", () => {
    const popupSender = {
      id: extensionId,
      tab: undefined,
      url: popupUrl,
    };
    // Popup must send commands to BackgroundMessageRouter, NOT directly to Offscreen.
    expect(isAuthorizedOffscreenCommandSender(popupSender, extensionId, backgroundUrl)).toBe(false);
  });

  it("rejects developer-test page sender", () => {
    const devSender = {
      id: extensionId,
      tab: undefined,
      url: devTestUrl,
    };
    expect(isAuthorizedOffscreenCommandSender(devSender, extensionId, backgroundUrl)).toBe(false);
  });

  it("rejects camera-test page sender", () => {
    const cameraSender = {
      id: extensionId,
      tab: undefined,
      url: cameraTestUrl,
    };
    expect(isAuthorizedOffscreenCommandSender(cameraSender, extensionId, backgroundUrl)).toBe(false);
  });

  it("rejects content scripts or external tabs", () => {
    const tabSender = {
      id: extensionId,
      tab: { id: 42 },
      url: "https://example.com/meet",
    };
    expect(isAuthorizedOffscreenCommandSender(tabSender, extensionId, backgroundUrl)).toBe(false);
  });

  it("rejects senders from a different extension ID", () => {
    const externalSender = {
      id: "other-extension-id",
      tab: undefined,
      url: undefined,
    };
    expect(isAuthorizedOffscreenCommandSender(externalSender, extensionId, backgroundUrl)).toBe(false);
  });
});
