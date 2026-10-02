import { describe, expect, it } from "vitest";
import { MediaEngine } from "../../src/media/media-engine";
import type { MediaTransferStore } from "../../src/media/media-transfer-store";
import { MediaRuntime } from "../../src/offscreen/media-runtime";
import { OffscreenRuntime } from "../../src/offscreen/runtime";

const emptyTransferStore: MediaTransferStore = {
  async stage(): Promise<string> { return "transfer_testfixture"; },
  async take(): Promise<File> { throw new Error("No file is staged in this lifecycle test."); },
  async delete(): Promise<void> { return undefined; },
  async clearExpired(): Promise<number> { return 0; },
};

describe("offscreen runtime", () => {
  it("initializes, reports status, shuts down, and can be initialized again", async () => {
    const engine = new MediaEngine({ transferStore: emptyTransferStore });
    const runtime = new OffscreenRuntime(new MediaRuntime(engine));

    expect((await runtime.initialize()).status).toBe("READY");
    expect(runtime.getStatus().status).toBe("READY");
    expect((await runtime.shutdown()).status).toBe("STOPPED");
    expect((await runtime.initialize()).status).toBe("READY");
  });
});
