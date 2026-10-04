import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { validateCommand } from "../../src/messaging/protocol";
import { exactHostPermissionPattern, normalizeWebOrigin } from "../../src/camera-integration/origin";
import { CAPCAM_MAX_MEDIA_SIZE_BYTES } from "../../src/media/media-limits";
import { detectMediaFormat, sniffMediaMimeType } from "../../src/media/mime-detection";

const manifestRaw = readFileSync(new URL("../../manifest.json", import.meta.url), "utf8");
const manifest = JSON.parse(manifestRaw) as Record<string, unknown>;

describe("Phase 11: Security, boundary validation, and permission audit", () => {
  describe("1. Manifest least-privilege security audit", () => {
    it("contains only minimal required MV3 permissions without broad wildcards", () => {
      expect(manifest.manifest_version).toBe(3);
      expect(manifest.permissions).toEqual(["storage", "offscreen"]);
      expect(manifest.host_permissions).toBeUndefined();
      expect(manifest.optional_permissions).toBeUndefined();
      expect(manifest.optional_host_permissions).toBeUndefined();
      expect(manifestRaw).not.toMatch(/<all_urls>|\*:\/\/\*|\.catch\s*all/);
    });

    it("does not register arbitrary content scripts or broad scripting permissions", () => {
      expect(manifest.content_scripts).toBeUndefined();
      expect(manifestRaw).not.toContain("scripting");
      expect(manifestRaw).not.toContain("declarativeNetRequest");
      expect(manifestRaw).not.toContain("webNavigation");
    });
  });

  describe("2. Protocol boundary and malformed message validation", () => {
    it("rejects non-object messages and envelopes with invalid protocol version", () => {
      const nonObject = validateCommand(null);
      expect(nonObject.ok).toBe(false);

      const invalidVersion = validateCommand({
        protocol: 999,
        requestId: "req_001",
        type: "runtime.getStatus",
      });
      expect(invalidVersion.ok).toBe(false);
      if (!invalidVersion.ok) {
        expect(invalidVersion.error.code).toBe("CAPCAM_PROTOCOL_ERROR");
      }
    });

    it("rejects commands with missing or malformed request IDs", () => {
      const missingReq = validateCommand({
        protocol: 1,
        type: "runtime.getStatus",
      });
      expect(missingReq.ok).toBe(false);

      const malformedReq = validateCommand({
        protocol: 1,
        requestId: "bad request id with spaces & dangerous chars!",
        type: "runtime.getStatus",
      });
      expect(malformedReq.ok).toBe(false);
    });

    it("rejects commands with extra unsupported keys (preventing prototype pollution)", () => {
      const extraKeys = validateCommand({
        protocol: 1,
        requestId: "req_clean_123",
        type: "runtime.getStatus",
        unauthorizedPayload: { secret: true },
      });
      expect(extraKeys.ok).toBe(false);
    });

    it("rejects malformed command payloads with invalid types or missing required keys", () => {
      const badStreamCreate = validateCommand({
        protocol: 1,
        requestId: "req_stream_1",
        type: "stream.create",
        payload: { mediaId: "not_a_valid_media_id", config: { width: -100 } },
      });
      expect(badStreamCreate.ok).toBe(false);

      const badPlaybackRate = validateCommand({
        protocol: 1,
        requestId: "req_pb_1",
        type: "playback.setRate",
        payload: { playbackId: "playback_valid12345", rate: "not-a-number" },
      });
      expect(badPlaybackRate.ok).toBe(false);
    });
  });

  describe("3. Origin and target security validation", () => {
    it("accepts only exact https:// and http://localhost origins", () => {
      expect(normalizeWebOrigin("https://meet.google.com")).toBe("https://meet.google.com");
      expect(normalizeWebOrigin("http://localhost:3000")).toBe("http://localhost:3000");
      expect(normalizeWebOrigin("http://127.0.0.1:8080")).toBe("http://127.0.0.1:8080");
    });

    it("rejects file URLs, wildcards, and credentials", () => {
      expect(normalizeWebOrigin("file:///Users/local/index.html")).toBeNull();
      expect(normalizeWebOrigin("https://*.wildcard.com")).toBeNull();
      expect(normalizeWebOrigin("https://user:pass@example.com")).toBeNull();
      expect(normalizeWebOrigin("chrome-extension://xyz")).toBeNull();
      expect(normalizeWebOrigin("")).toBeNull();
    });

    it("restricts host permission patterns strictly to default port origins without wildcard expansion", () => {
      expect(exactHostPermissionPattern("https://meet.google.com")).toBe("https://meet.google.com/*");
      // Rejects non-standard ports to prevent permission over-expansion in Chrome
      expect(exactHostPermissionPattern("https://meet.google.com:8443")).toBeNull();
      expect(exactHostPermissionPattern("invalid-origin")).toBeNull();
    });
  });

  describe("4. Media validation bounds and safety limits", () => {
    it("enforces 512 MiB maximum safety limit constant", () => {
      expect(CAPCAM_MAX_MEDIA_SIZE_BYTES).toBe(512 * 1024 * 1024);
    });

    it("detects valid image headers and rejects unsupported executables or SVGs", () => {
      const pngHeader = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      expect(sniffMediaMimeType(pngHeader)).toBe("image/png");

      const format = detectMediaFormat("image/png", pngHeader);
      expect(format.kind).toBe("image");
      expect(format.mimeType).toBe("image/png");

      const exeHeader = new Uint8Array([0x4d, 0x5a, 0x90, 0x00]); // MZ header
      expect(() => detectMediaFormat("application/octet-stream", exeHeader)).toThrowError();
      expect(() => detectMediaFormat("image/svg+xml", new Uint8Array([0x3c, 0x73, 0x76, 0x67]))).toThrowError();
    });
  });
});
