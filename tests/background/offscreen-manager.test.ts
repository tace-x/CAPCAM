import { describe, expect, it } from "vitest";
import { OffscreenManager, type OffscreenPlatform } from "../../src/background/offscreen-manager";
import { createSuccessResponse } from "../../src/messaging/protocol";
import { validateCommand } from "../../src/messaging/protocol";
import type { OffscreenRuntimeInfo } from "../../src/shared/types";

class FakeOffscreenPlatform implements OffscreenPlatform {
  exists = false;
  createCalls = 0;
  closeCalls = 0;
  failFirstMessage = true;
  private info: OffscreenRuntimeInfo = { status: "STOPPED", initializedAt: null };

  async hasDocument(): Promise<boolean> {
    return this.exists;
  }

  async createDocument(): Promise<void> {
    this.createCalls += 1;
    this.exists = true;
    this.info = { status: "READY", initializedAt: Date.now() };
  }

  async closeDocument(): Promise<void> {
    this.closeCalls += 1;
    this.exists = false;
  }

  async sendMessage(message: unknown): Promise<unknown> {
    if (this.failFirstMessage) {
      this.failFirstMessage = false;
      throw new Error("Simulated offscreen context loss.");
    }
    const result = validateCommand(message);
    if (!result.ok) throw result.error;
    if (result.command.type === "offscreen.shutdown") this.info = { status: "STOPPED", initializedAt: null };
    if (result.command.type === "offscreen.initialize") this.info = { status: "READY", initializedAt: Date.now() };
    return createSuccessResponse(result.command.requestId, { ...this.info });
  }
}

describe("offscreen document manager", () => {
  it("recreates an unresponsive document and retries initialization", async () => {
    const platform = new FakeOffscreenPlatform();
    const manager = new OffscreenManager(platform);

    const status = await manager.initialize();

    expect(status.status).toBe("READY");
    expect(platform.createCalls).toBe(2);
    expect(platform.closeCalls).toBe(1);
  });
});
