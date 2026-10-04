import { describe, expect, it, vi } from "vitest";
import { MediaEngine } from "../../src/media/media-engine";
import type { MediaRecord } from "../../src/media/media-types";
import { MediaRuntime } from "../../src/offscreen/media-runtime";
import { StreamManager } from "../../src/stream/stream-manager";

describe("offscreen stream/media resource ordering", () => {
  it("disposes the active stream before removing its media source", async () => {
    const calls: string[] = [];
    const engine = {
      remove: vi.fn(async (mediaId: string) => {
        calls.push(`remove:${mediaId}`);
        return { id: mediaId } as MediaRecord;
      }),
    } as unknown as MediaEngine;
    const streams = {
      disposeForMedia: vi.fn(async (mediaId: string) => { calls.push(`dispose:${mediaId}`); }),
      disposeAll: vi.fn(async () => { calls.push("dispose-all"); }),
    } as unknown as StreamManager;
    const runtime = new MediaRuntime(engine, streams);

    const removed = await runtime.remove({ mediaId: "med_source0001" });
    expect(removed.id).toBe("med_source0001");
    expect(calls).toEqual(["dispose:med_source0001", "remove:med_source0001"]);
  });

  it("disposes all streams before clearing media", async () => {
    const calls: string[] = [];
    const engine = {
      clear: vi.fn(async () => {
        calls.push("clear-media");
        return { removed: 2 };
      }),
    } as unknown as MediaEngine;
    const streams = {
      disposeAll: vi.fn(async () => { calls.push("dispose-all"); }),
    } as unknown as StreamManager;
    const runtime = new MediaRuntime(engine, streams);

    await expect(runtime.clear()).resolves.toEqual({ removed: 2 });
    expect(calls).toEqual(["dispose-all", "clear-media"]);
  });
});
