import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { PHASE_06_VERIFIED } from "../../src/config/capabilities";

const pkgRaw = readFileSync(new URL("../../package.json", import.meta.url), "utf8");
const pkg = JSON.parse(pkgRaw) as Record<string, unknown>;

const manifestRaw = readFileSync(new URL("../../manifest.json", import.meta.url), "utf8");
const manifest = JSON.parse(manifestRaw) as Record<string, unknown>;

describe("Phase 12: Release packaging and distribution integrity", () => {
  describe("1. Release metadata & Versioning consistency", () => {
    it("maintains exact version alignment across package.json and manifest.json", () => {
      expect(pkg.version).toBe("0.1.0");
      expect(manifest.version).toBe("0.1.0");
      expect(pkg.version).toBe(manifest.version);
    });

    it("declares standard npm release and packaging scripts", () => {
      const scripts = pkg.scripts as Record<string, string>;
      expect(scripts["verify:release"]).toBe("node scripts/verify-release.mjs");
      expect(scripts.package).toBe("node scripts/package-release.mjs");
      expect(scripts.build).toBe("vite build && node scripts/copy-extension-assets.mjs");
      expect(scripts["build:camera-test"]).toBe("vite build --mode camera-test && node scripts/copy-extension-assets.mjs");
    });
  });

  describe("2. Release scripts presence and integrity", () => {
    it("provides executable node verification and packaging scripts", () => {
      expect(existsSync(new URL("../../scripts/verify-release.mjs", import.meta.url))).toBe(true);
      expect(existsSync(new URL("../../scripts/package-release.mjs", import.meta.url))).toBe(true);
      expect(existsSync(new URL("../../scripts/copy-extension-assets.mjs", import.meta.url))).toBe(true);
    });
  });

  describe("3. Manifest distribution safety", () => {
    it("enforces strict Manifest V3 without broad permissions or external injections", () => {
      expect(manifest.manifest_version).toBe(3);
      expect(manifest.permissions).toEqual(["storage", "offscreen"]);
      expect(manifest.host_permissions).toBeUndefined();
      expect(manifest.optional_permissions).toBeUndefined();
      expect(manifest.content_scripts).toBeUndefined();
    });
  });

  describe("4. Verification gate invariant", () => {
    it("keeps PHASE_06_VERIFIED false until real Chrome browser testing is performed", () => {
      expect(PHASE_06_VERIFIED).toBe(false);
    });
  });
});
