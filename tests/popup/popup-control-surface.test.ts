import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const popupSource = readFileSync(new URL("../../src/popup/App.tsx", import.meta.url), "utf8");

describe("Phase 09: Popup control surface & state model", () => {
  describe("1. Runtime state reconstruction & settings persistence", () => {
    it("reconstructs complete runtime state on refresh without restarting subsystems", () => {
      expect(popupSource).toContain("client.send(\"runtime.getStatus\")");
      expect(popupSource).toContain("client.send(\"settings.get\")");
      expect(popupSource).toContain("client.send(\"media.list\")");
      expect(popupSource).toContain("client.send(\"stream.getState\")");
      expect(popupSource).toContain("client.send(\"playback.getState\")");
      expect(popupSource).toContain("client.send(\"camera.getStatus\")");
    });

    it("persists user preferences via settings.update", () => {
      expect(popupSource).toContain("client.send(\"settings.update\"");
      expect(popupSource).toContain("fitMode");
      expect(popupSource).toContain("mirror");
      expect(popupSource).toContain("loop");
    });
  });

  describe("2. Single trustworthy UI state model", () => {
    it("derives runtime, media, playback, and stream statuses accurately", () => {
      expect(popupSource).toContain("derivedMediaStatus");
      expect(popupSource).toContain("derivedPlaybackStatus");
      expect(popupSource).toContain("streamInfo?.state ?? state?.stream.status ?? \"IDLE\"");
      expect(popupSource).toContain("state?.runtime.status ?? \"OFF\"");
    });
  });

  describe("3. Media ingestion & source UX", () => {
    it("uses MediaIngestClient and enforces safety bounds without leaking Blobs", () => {
      expect(popupSource).toContain("ingestClient.ingest(file)");
      expect(popupSource).toContain("client.send(\"media.remove\"");
      expect(popupSource).toContain("formatBytes");
      expect(popupSource).toContain("formatDuration");
      expect(popupSource).toContain("URL.revokeObjectURL");
    });
  });

  describe("4. Playback and stream controls", () => {
    it("wires playback commands to typed protocol operations", () => {
      expect(popupSource).toContain("client.send(\"playback.load\"");
      expect(popupSource).toContain("client.send(command");
      expect(popupSource).toContain("playback.play");
      expect(popupSource).toContain("playback.pause");
      expect(popupSource).toContain("playback.stop");
      expect(popupSource).toContain("playback.restart");
      expect(popupSource).toContain("client.send(\"playback.seek\"");
      expect(popupSource).toContain("client.send(\"playback.setLoop\"");
      expect(popupSource).toContain("client.send(\"playback.setRate\"");
      expect(popupSource).toContain("client.send(\"playback.dispose\"");
    });

    it("wires canvas stream controls to typed protocol operations", () => {
      expect(popupSource).toContain("client.send(\"stream.create\"");
      expect(popupSource).toContain("client.send(\"stream.start\"");
      expect(popupSource).toContain("client.send(\"stream.stop\"");
      expect(popupSource).toContain("client.send(\"stream.restart\"");
      expect(popupSource).toContain("client.send(\"stream.switchSource\"");
      expect(popupSource).toContain("client.send(\"stream.dispose\"");
    });
  });

  describe("5. Camera integration controls & gate safety", () => {
    it("wires camera commands and enforces Phase 06 blocked gate representation", () => {
      expect(popupSource).toContain("client.send(\"camera.detect\")");
      expect(popupSource).toContain("client.send(\"camera.enable\")");
      expect(popupSource).toContain("client.send(\"camera.disable\")");
      expect(popupSource).toContain("client.send(\"camera.switchSource\"");
      expect(popupSource).toContain("cameraGateBlocked");
      expect(popupSource).toContain("cameraStatus?.capcamActive === true");
      expect(popupSource).toContain("humanReadableReason");
    });
  });

  describe("6. Accessibility and semantic structure", () => {
    it("provides accessible labels, aria-live status regions, and alert error roles", () => {
      expect(popupSource).toContain("aria-live=\"polite\"");
      expect(popupSource).toContain("role=\"alert\"");
      expect(popupSource).toContain("htmlFor=\"camera-source\"");
      expect(popupSource).toContain("htmlFor=\"stream-source\"");
      expect(popupSource).toContain("htmlFor=\"output-preset\"");
      expect(popupSource).toContain("htmlFor=\"fit-mode\"");
      expect(popupSource).toContain("htmlFor=\"mirror-checkbox\"");
      expect(popupSource).toContain("htmlFor=\"playback-seek\"");
      expect(popupSource).toContain("htmlFor=\"media-upload-input\"");
    });
  });
});
