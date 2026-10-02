import { describe, expect, it } from "vitest";
import { MediaRuntime } from "../../src/offscreen/media-runtime";
import { OffscreenRuntime } from "../../src/offscreen/runtime";

describe("offscreen runtime", () => {
  it("initializes, reports status, shuts down, and can be initialized again", async () => {
    const runtime = new OffscreenRuntime(new MediaRuntime());

    expect((await runtime.initialize()).status).toBe("READY");
    expect(runtime.getStatus().status).toBe("READY");
    expect((await runtime.shutdown()).status).toBe("STOPPED");
    expect((await runtime.initialize()).status).toBe("READY");
  });
});
