import { describe, expect, it } from "vitest";
import { ObjectUrlManager, type ObjectUrlApi } from "../../src/media/object-url-manager";

class FakeObjectUrlApi implements ObjectUrlApi {
  created: string[] = [];
  revoked: string[] = [];

  createObjectURL(): string {
    const url = `blob:capcam/${this.created.length + 1}`;
    this.created.push(url);
    return url;
  }

  revokeObjectURL(url: string): void {
    this.revoked.push(url);
  }
}

describe("object URL management", () => {
  it("creates, tracks, revokes, and revokes all URLs", () => {
    const api = new FakeObjectUrlApi();
    const manager = new ObjectUrlManager(api);
    const first = manager.create(new Blob(["first"]));
    const second = manager.create(new Blob(["second"]));

    expect(manager.isTracked(first)).toBe(true);
    expect(manager.size).toBe(2);
    expect(manager.revoke(first)).toBe(true);
    expect(manager.revoke(first)).toBe(false);
    expect(manager.revokeAll()).toBe(1);
    expect(api.revoked).toEqual([first, second]);
    expect(manager.size).toBe(0);
  });

  it("rejects tracking URLs that it does not own", () => {
    const manager = new ObjectUrlManager(new FakeObjectUrlApi());
    expect(() => manager.track("https://example.test/file.png")).toThrow();
  });
});
