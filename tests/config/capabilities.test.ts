import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { detectCapabilities } from "../../src/config/capabilities";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("pre-Phase-07 safety gate", () => {
  it("keeps cameraReplacement false even when the extension media APIs exist", () => {
    vi.stubGlobal("chrome", {
      runtime: { getManifest: () => ({ manifest_version: 3 }) },
      storage: { local: {} },
      offscreen: { createDocument: () => undefined },
    });

    expect(detectCapabilities()).toEqual({
      manifestV3: true,
      extensionStorage: true,
      offscreenDocument: true,
      mediaProcessing: false,
      cameraReplacement: false,
    });
  });

  it("keeps the production manifest free of site access and content injection", () => {
    const manifestText = readFileSync(new URL("../../manifest.json", import.meta.url), "utf8");
    const manifest = JSON.parse(manifestText) as Record<string, unknown>;

    expect(manifest.permissions).toEqual(["storage", "offscreen"]);
    expect(manifest).not.toHaveProperty("host_permissions");
    expect(manifest).not.toHaveProperty("optional_host_permissions");
    expect(manifest).not.toHaveProperty("content_scripts");
  });
});
