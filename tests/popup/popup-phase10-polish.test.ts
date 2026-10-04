import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const popupSource = readFileSync(new URL("../../src/popup/App.tsx", import.meta.url), "utf8");
const popupStyles = readFileSync(new URL("../../src/popup/styles.css", import.meta.url), "utf8");
const errorSurfaceSource = readFileSync(new URL("../../src/popup/components/ErrorSurface.tsx", import.meta.url), "utf8");
const keyboardModalSource = readFileSync(new URL("../../src/popup/components/KeyboardHelpModal.tsx", import.meta.url), "utf8");
const statusRowSource = readFileSync(new URL("../../src/popup/components/StatusRow.tsx", import.meta.url), "utf8");

describe("Phase 10: Developer Tool Polish & Premium UI", () => {
  describe("1. Product identity & Signature header", () => {
    it("renders compact signature header with version, offline local badge, and refresh control", () => {
      expect(popupSource).toContain("CAPCAM");
      expect(popupSource).toContain("v0.1.0");
      expect(popupSource).toContain("Local-first media · In-browser");
      expect(popupSource).toContain("Offline Local");
      expect(popupSource).toContain("Local Runtime Ready");
    });
  });

  describe("2. Semantic status system", () => {
    it("provides consistent semantic status classes and accessible indicator badges", () => {
      expect(statusRowSource).toContain("status-indicator");
      expect(statusRowSource).toContain("status-${normalizedStatus}");
      expect(popupStyles).toContain(".status-ready .status-indicator");
      expect(popupStyles).toContain(".status-active .status-indicator");
      expect(popupStyles).toContain(".status-error .status-indicator");
      expect(popupStyles).toContain(".status-blocked .status-indicator");
      expect(popupStyles).toContain(".status-stopped .status-indicator");
    });
  });

  describe("3. Structured error surfaces with actionable recovery", () => {
    it("implements ErrorSurface with action recovery buttons and alert roles", () => {
      expect(errorSurfaceSource).toContain("role=\"alert\"");
      expect(errorSurfaceSource).toContain("error-surface");
      expect(errorSurfaceSource).toContain("error-action-button");
      expect(errorSurfaceSource).toContain("error-dismiss-button");
      expect(popupSource).toContain("<ErrorSurface");
    });
  });

  describe("4. Keyboard shortcuts & Accessible help dialog", () => {
    it("registers global keyboard handlers for Space, R, M, C, Esc, and ?", () => {
      expect(popupSource).toContain("e.code === \"Space\"");
      expect(popupSource).toContain("e.key === \"r\" || e.key === \"R\"");
      expect(popupSource).toContain("e.key === \"m\" || e.key === \"M\"");
      expect(popupSource).toContain("e.key === \"c\" || e.key === \"C\"");
      expect(popupSource).toContain("e.key === \"Escape\"");
      expect(popupSource).toContain("e.key === \"?\"");
    });

    it("provides a dedicated KeyboardHelpModal with semantic shortcuts list", () => {
      expect(keyboardModalSource).toContain("role=\"dialog\"");
      expect(keyboardModalSource).toContain("aria-modal=\"true\"");
      expect(keyboardModalSource).toContain("Keyboard Shortcuts");
      expect(keyboardModalSource).toContain("<kbd className=\"shortcut-key\">{item.keyCombo}</kbd>");
      expect(keyboardModalSource).toContain("keyCombo: \"Space\"");
      expect(popupSource).toContain("<KeyboardHelpModal");
    });
  });

  describe("5. Accessibility, Reduced motion & High-density styling", () => {
    it("includes prefers-reduced-motion media query and visible focus styles", () => {
      expect(popupStyles).toContain("@media (prefers-reduced-motion: reduce)");
      expect(popupStyles).toContain(":focus-visible");
      expect(popupStyles).toContain("outline: 2px solid var(--border-focus)");
    });

    it("enforces compact layout constraints without overflow", () => {
      expect(popupStyles).toContain("width: 460px");
      expect(popupStyles).toContain("max-height: 600px");
      expect(popupStyles).toContain("overflow-x: hidden");
      expect(popupStyles).toContain("overflow-y: auto");
    });
  });
});
