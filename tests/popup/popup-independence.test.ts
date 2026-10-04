import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const popupSource = readFileSync(new URL("../../src/popup/App.tsx", import.meta.url), "utf8");
const popupEntry = readFileSync(new URL("../../src/popup/main.tsx", import.meta.url), "utf8");

describe("popup runtime ownership boundary", () => {
  it("uses typed messaging as a client and does not construct or own runtime subsystems", () => {
    expect(popupSource).toContain("new MessagingClient()");
    expect(popupSource).toContain("client.send(");
    expect(popupSource).not.toMatch(/chrome\.offscreen|createDocument\s*\(|new\s+(?:RuntimeManager|MediaRuntime|MediaEngine|PlaybackEngine|StreamManager|CanvasStreamPipelineFactory)\s*\(/);
    expect(popupEntry).not.toMatch(/chrome\.offscreen|RuntimeManager|MediaRuntime|MediaEngine|PlaybackEngine|StreamManager/);
  });

  it("exposes camera controls and serializable status while keeping native media outside the popup pipeline", () => {
    expect(popupSource).toContain("camera.statusChanged");
    expect(popupSource).toContain("client.send(\"camera.enable\")");
    expect(popupSource).toContain("client.send(\"camera.disable\")");
    expect(popupSource).toContain("client.send(\"camera.switchSource\"");
    expect(popupSource).toContain("media-preview");
    expect(popupSource).toContain("URL.revokeObjectURL(url)");
    expect(popupSource).not.toMatch(/new\s+MediaStream\s*\(|new\s+RTCPeerConnection\s*\(|getUserMedia\s*\(/);
  });
});
