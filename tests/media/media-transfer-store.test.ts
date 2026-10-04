import { describe, expect, it } from "vitest";
import { IndexedDbMediaTransferStore } from "../../src/media/media-transfer-store";

describe("IndexedDbMediaTransferStore resilience and handoff", () => {
  it("stages and takes files using fallback when indexedDB is unavailable", async () => {
    const store = new IndexedDbMediaTransferStore();
    const file = new File(["local-stream-media-bytes"], "photo.jpg", { type: "image/jpeg" });

    const transferId = await store.stage(file);
    expect(transferId).toMatch(/^transfer_[A-Za-z0-9-]{8,100}$/);

    const taken = await store.take(transferId);
    expect(taken.name).toBe("photo.jpg");
    expect(taken.type).toBe("image/jpeg");
    expect(await taken.text()).toBe("local-stream-media-bytes");

    // Second take should fail because item was already consumed
    await expect(store.take(transferId)).rejects.toMatchObject({
      mediaCode: "MEDIA_TRANSFER_FAILED",
    });
  });

  it("deletes and sweeps expired transfers cleanly", async () => {
    const store = new IndexedDbMediaTransferStore();
    const file = new File(["temporary-bytes"], "temp.png", { type: "image/png" });

    const transferId = await store.stage(file);
    await store.delete(transferId);

    await expect(store.take(transferId)).rejects.toMatchObject({
      mediaCode: "MEDIA_TRANSFER_FAILED",
    });

    const swept = await store.clearExpired();
    expect(typeof swept).toBe("number");
  });
});
