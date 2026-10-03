import { afterEach, describe, expect, it, vi } from "vitest";
import { createChromeOffscreenPlatform } from "../../src/background/offscreen-manager";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Chrome offscreen platform compatibility", () => {
  it("detects the offscreen document with runtime.getContexts (Chrome 116 API)", async () => {
    const getContexts = vi.fn(async (_filter: { contextTypes: string[]; documentUrls: string[] }) => [
      { contextType: "OFFSCREEN_DOCUMENT" },
    ]);
    const getURL = vi.fn((path: string) => `chrome-extension://capcam-test/${path}`);
    vi.stubGlobal("chrome", {
      runtime: { getContexts, getURL },
      offscreen: {
        createDocument: vi.fn(),
        closeDocument: vi.fn(),
        Reason: { BLOBS: "BLOBS" },
      },
    });

    const platform = createChromeOffscreenPlatform();

    await expect(platform.hasDocument()).resolves.toBe(true);
    expect(getContexts).toHaveBeenCalledWith({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: ["chrome-extension://capcam-test/public/offscreen.html"],
    });
  });

  it("reports no offscreen document when the Chrome context query is empty", async () => {
    const getContexts = vi.fn(async () => []);
    vi.stubGlobal("chrome", {
      runtime: {
        getContexts,
        getURL: (path: string) => `chrome-extension://capcam-test/${path}`,
      },
      offscreen: { Reason: { BLOBS: "BLOBS" } },
    });

    await expect(createChromeOffscreenPlatform().hasDocument()).resolves.toBe(false);
  });
});
