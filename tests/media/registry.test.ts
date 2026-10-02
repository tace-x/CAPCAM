import { describe, expect, it } from "vitest";
import { MediaRegistry } from "../../src/media/media-registry";
import { MediaEngineError } from "../../src/media/media-errors";
import type { MediaRecord } from "../../src/media/media-types";

function mediaRecord(id: string): MediaRecord {
  return {
    id,
    name: "sample.png",
    kind: "image",
    mimeType: "image/png",
    size: 10,
    width: null,
    height: null,
    aspectRatio: null,
    duration: null,
    sourceUrl: null,
    createdAt: 1,
    status: "NEW",
    capabilities: { canDecode: false, canSeek: false, supportsAudio: false },
  };
}

describe("media registry", () => {
  it("registers, retrieves, lists, checks, removes, and clears records", () => {
    const registry = new MediaRegistry();
    const first = mediaRecord("med_fixture0001");
    const second = mediaRecord("med_fixture0002");

    registry.register(first);
    registry.register(second);
    expect(registry.has(first.id)).toBe(true);
    expect(registry.get(first.id)).toEqual(first);
    expect(registry.list()).toHaveLength(2);
    expect(registry.remove(first.id)).toEqual(first);
    expect(registry.get(first.id)).toBeUndefined();
    expect(registry.clear()).toEqual([second]);
    expect(registry.size).toBe(0);
  });

  it("rejects duplicate IDs and returns defensive record copies", () => {
    const registry = new MediaRegistry();
    const record = mediaRecord("med_fixture0003");
    registry.register(record);
    expect(() => registry.register(record)).toThrowError(MediaEngineError);

    const copy = registry.get(record.id);
    if (copy === undefined) throw new Error("Expected a registry record.");
    copy.capabilities.canDecode = true;
    expect(registry.get(record.id)?.capabilities.canDecode).toBe(false);
  });
});
