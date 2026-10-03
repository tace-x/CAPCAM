import { describe, expect, it } from "vitest";
import { MessagingClient, type MessageTransport } from "../../src/messaging/client";
import { isPlainRecord } from "../../src/messaging/protocol";
import { createSuccessResponse } from "../../src/messaging/protocol";
import { MediaEngineError } from "../../src/media/media-errors";
import { MediaIngestClient } from "../../src/media/media-ingest-client";
import { CAPCAM_MAX_MEDIA_SIZE_BYTES, MEDIA_TRANSFER_TTL_MS } from "../../src/media/media-limits";
import { isExpiredMediaTransfer } from "../../src/media/media-transfer-store";
import type { MediaRecord } from "../../src/media/media-types";
import type { MediaTransferStore } from "../../src/media/media-transfer-store";

class MemoryTransferStore implements MediaTransferStore {
  readonly staged = new Map<string, File>();
  readonly deleted: string[] = [];
  private nextId = 0;

  async stage(file: File): Promise<string> {
    this.nextId += 1;
    const transferId = `transfer_handoff${this.nextId.toString().padStart(4, "0")}`;
    this.staged.set(transferId, file);
    return transferId;
  }

  async take(transferId: string): Promise<File> {
    const file = this.staged.get(transferId);
    if (file === undefined) throw new MediaEngineError("MEDIA_TRANSFER_FAILED");
    this.staged.delete(transferId);
    return file;
  }

  async delete(transferId: string): Promise<void> {
    this.deleted.push(transferId);
    this.staged.delete(transferId);
  }

  async clearExpired(): Promise<number> {
    return 0;
  }
}

function mediaRecord(index: number, file: File): MediaRecord {
  return {
    id: `med_fixture${String(index).padStart(4, "0")}`,
    name: file.name,
    kind: "image",
    mimeType: "image/png",
    size: file.size,
    width: 1,
    height: 1,
    aspectRatio: 1,
    duration: null,
    sourceUrl: `blob:handoff-test/${index}`,
    createdAt: index,
    status: "READY",
    capabilities: { canDecode: true, canSeek: false, supportsAudio: false },
  };
}

describe("popup media handoff", () => {
  it("sends only a temporary transfer ID and deletes the handoff after success", async () => {
    const store = new MemoryTransferStore();
    const file = new File(["local bytes"], "sample.png", { type: "image/png" });
    let sentMessage: unknown;
    const transport: MessageTransport = {
      async sendMessage(message) {
        sentMessage = message;
        if (!isPlainRecord(message) || typeof message.requestId !== "string") throw new Error("Invalid command.");
        const staged = Array.from(store.staged.keys())[0];
        if (staged === undefined) throw new Error("Expected one staged transfer.");
        return createSuccessResponse(message.requestId, mediaRecord(1, file));
      },
    };
    const client = new MediaIngestClient(new MessagingClient(transport), store);

    const result = await client.ingest(file);
    expect(result.name).toBe("sample.png");
    expect(isPlainRecord(sentMessage)).toBe(true);
    if (!isPlainRecord(sentMessage)) throw new Error("Expected a command object.");
    expect(sentMessage.type).toBe("media.register");
    expect(Object.keys(sentMessage)).toEqual(["protocol", "requestId", "type", "payload"]);
    expect(sentMessage.payload).toEqual({ transferId: "transfer_handoff0001" });
    expect(store.deleted).toEqual(["transfer_handoff0001"]);
    expect(store.staged.size).toBe(0);
  });

  it("cleans failed handoffs and supports concurrent independent uploads", async () => {
    const store = new MemoryTransferStore();
    const files = [
      new File(["one"], "one.png", { type: "image/png" }),
      new File(["two"], "two.png", { type: "image/png" }),
      new File(["three"], "three.png", { type: "image/png" }),
    ];
    const transferIdsSent: string[] = [];
    const transport: MessageTransport = {
      async sendMessage(message) {
        if (!isPlainRecord(message) || typeof message.requestId !== "string" || !isPlainRecord(message.payload)) {
          throw new Error("Invalid command.");
        }
        const transferId = String(message.payload.transferId);
        transferIdsSent.push(transferId);
        const fileIndex = files.findIndex((file) => store.staged.get(transferId) === file);
        return createSuccessResponse(message.requestId, mediaRecord(fileIndex + 1, files[fileIndex] ?? files[0]!));
      },
    };
    const client = new MediaIngestClient(new MessagingClient(transport), store);
    const results = await Promise.all(files.map((file) => client.ingest(file)));

    expect(results.map((record) => record.name)).toEqual(["one.png", "two.png", "three.png"]);
    expect(new Set(transferIdsSent).size).toBe(3);
    expect(store.deleted).toHaveLength(3);
    expect(store.staged.size).toBe(0);

    const failingClient = new MediaIngestClient(new MessagingClient({
      async sendMessage(message) {
        if (!isPlainRecord(message) || typeof message.requestId !== "string") throw new Error("Invalid command.");
        return {
          protocol: 1,
          requestId: message.requestId,
          success: false,
          error: { code: "CAPCAM_MEDIA_ERROR", message: "Decoder rejected this file." },
        };
      },
    }), store);
    await expect(failingClient.ingest(files[0]!)).rejects.toMatchObject({ code: "CAPCAM_MEDIA_ERROR" });
    expect(store.deleted).toHaveLength(4);
    expect(store.staged.size).toBe(0);
  });

  it("expires abandoned local handoffs after the configured TTL", () => {
    const now = 1_000_000;
    expect(isExpiredMediaTransfer(now - MEDIA_TRANSFER_TTL_MS - 1, now)).toBe(true);
    expect(isExpiredMediaTransfer(now - MEDIA_TRANSFER_TTL_MS, now)).toBe(false);
    expect(isExpiredMediaTransfer(now, now)).toBe(false);
    expect(isExpiredMediaTransfer(Number.NaN, now)).toBe(true);
  });

  it("rejects the size ceiling before staging the file", async () => {
    const store = new MemoryTransferStore();
    const oversizedFile = {
      name: "large.mp4",
      size: CAPCAM_MAX_MEDIA_SIZE_BYTES + 1,
      type: "video/mp4",
    } as File;
    const client = new MediaIngestClient(new MessagingClient({ sendMessage: async () => undefined }), store);

    await expect(client.ingest(oversizedFile)).rejects.toMatchObject({ mediaCode: "MEDIA_TOO_LARGE" });
    expect(store.staged.size).toBe(0);
  });
});
