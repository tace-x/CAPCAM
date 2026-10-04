import { describe, expect, it } from "vitest";
import { BackgroundMessageRouter } from "../../src/background/message-router";
import { OffscreenManager, type OffscreenPlatform } from "../../src/background/offscreen-manager";
import { BackgroundRuntime } from "../../src/background/runtime";
import { MediaEngine } from "../../src/media/media-engine";
import { MediaIngestClient } from "../../src/media/media-ingest-client";
import { ObjectUrlManager, type ObjectUrlApi } from "../../src/media/object-url-manager";
import type { ImageResourceManagerPort } from "../../src/media/image-resource-manager";
import type { ImageResourceInfo } from "../../src/media/media-types";
import type { MediaTransferStore } from "../../src/media/media-transfer-store";
import { MessagingClient } from "../../src/messaging/client";
import { CommandRouter } from "../../src/messaging/router";
import { isEventEnvelope, isResponseEnvelope } from "../../src/messaging/protocol";
import { MediaRuntime } from "../../src/offscreen/media-runtime";
import { OffscreenRuntime } from "../../src/offscreen/runtime";
import { DEFAULT_SETTINGS, type CapCamSettings } from "../../src/storage/settings";
import type { EventEnvelope } from "../../src/messaging/events";
import { createPngFile } from "../media/fixtures";

class MemoryTransferStore implements MediaTransferStore {
  private readonly files = new Map<string, File>();
  private nextId = 0;

  async stage(file: File): Promise<string> {
    this.nextId += 1;
    const transferId = `transfer_integr${this.nextId.toString().padStart(4, "0")}`;
    this.files.set(transferId, file);
    return transferId;
  }

  async take(transferId: string): Promise<File> {
    const file = this.files.get(transferId);
    this.files.delete(transferId);
    if (file === undefined) throw new Error("The staged file was not found.");
    return file;
  }

  async delete(transferId: string): Promise<void> {
    this.files.delete(transferId);
  }

  async clearExpired(): Promise<number> {
    return 0;
  }
}

class FakeImageResources implements ImageResourceManagerPort {
  readonly loaded: string[] = [];
  readonly released: string[] = [];

  async load(mediaId: string, _url: string, _signal: AbortSignal): Promise<ImageResourceInfo> {
    this.loaded.push(mediaId);
    return { width: 1600, height: 900 };
  }

  async releaseImage(mediaId: string): Promise<void> {
    this.released.push(mediaId);
  }

  hasImage(mediaId: string): boolean {
    return this.loaded.includes(mediaId) && !this.released.includes(mediaId);
  }
}

class FakeObjectUrlApi implements ObjectUrlApi {
  private next = 0;
  readonly revoked: string[] = [];

  createObjectURL(_file: Blob): string {
    this.next += 1;
    return `blob:protocol-test/${this.next}`;
  }

  revokeObjectURL(url: string): void {
    this.revoked.push(url);
  }
}

class FakeOffscreenPlatform implements OffscreenPlatform {
  exists = false;
  readonly sentMessages: unknown[] = [];

  constructor(
    private readonly router: CommandRouter,
    private readonly initializeRuntime: () => Promise<unknown>,
  ) {}

  async hasDocument(): Promise<boolean> {
    return this.exists;
  }

  async createDocument(): Promise<void> {
    this.exists = true;
    await this.initializeRuntime();
  }

  async closeDocument(): Promise<void> {
    this.exists = false;
  }

  sendMessage(message: unknown): Promise<unknown> {
    this.sentMessages.push(message);
    return this.router.handle(message);
  }
}

class FakeSettings {
  async getSettings(): Promise<CapCamSettings> {
    return { ...DEFAULT_SETTINGS };
  }

  async updateSettings(patch: Partial<CapCamSettings>): Promise<CapCamSettings> {
    return { ...DEFAULT_SETTINGS, ...patch };
  }
}

describe("popup → service worker → offscreen media commands", () => {
  it("hands off local files by ID and exercises register/get/list/inspect/remove/clear", async () => {
    const transferStore = new MemoryTransferStore();
    const imageResources = new FakeImageResources();
    const urlApi = new FakeObjectUrlApi();
    const events: EventEnvelope[] = [];
    const engine = new MediaEngine({
      transferStore,
      imageResources,
      objectUrls: new ObjectUrlManager(urlApi),
      publishEvent: (event) => events.push(event),
    });
    const mediaRuntime = new MediaRuntime(engine);
    const offscreenRuntime = new OffscreenRuntime(mediaRuntime);
    const runtimeManager = offscreenRuntime.manager;
    const offscreenRouter = new CommandRouter({
      authorize: (command) => runtimeManager.authorizeCommand(command.type, command.runtimeSessionId),
      getRuntimeSessionId: () => runtimeManager.getState().runtimeSessionId,
    });
    offscreenRouter.register("runtime.initialize", () => runtimeManager.initialize());
    offscreenRouter.register("runtime.shutdown", () => runtimeManager.shutdown());
    offscreenRouter.register("runtime.reset", () => runtimeManager.reset());
    offscreenRouter.register("runtime.getState", () => runtimeManager.getState());
    offscreenRouter.register("runtime.getDiagnostics", () => runtimeManager.getDiagnostics());
    offscreenRouter.register("runtime.ping", () => runtimeManager.ping());
    offscreenRouter.register("media.register", (payload) => runtimeManager.runSubsystemOperation(() => mediaRuntime.register(payload)));
    offscreenRouter.register("media.get", (payload) => runtimeManager.runSubsystemOperation(() => mediaRuntime.get(payload)));
    offscreenRouter.register("media.list", () => runtimeManager.runSubsystemOperation(() => mediaRuntime.list()));
    offscreenRouter.register("media.remove", (payload) => runtimeManager.runSubsystemOperation(() => mediaRuntime.remove(payload)));
    offscreenRouter.register("media.clear", () => runtimeManager.runSubsystemOperation(() => mediaRuntime.clear()));
    offscreenRouter.register("media.inspect", (payload) => runtimeManager.runSubsystemOperation(() => mediaRuntime.inspect(payload)));

    const platform = new FakeOffscreenPlatform(offscreenRouter, () => runtimeManager.initialize());
    const offscreenManager = new OffscreenManager(platform);
    const backgroundRuntime = new BackgroundRuntime(offscreenManager, new FakeSettings());
    const backgroundRouter = new BackgroundMessageRouter(
      backgroundRuntime,
      "capcam-test",
      "chrome-extension://capcam-test/",
    );
    const client = new MessagingClient({
      sendMessage: (message) => backgroundRouter.handle(message, {
        id: "capcam-test",
        url: "chrome-extension://capcam-test/popup.html",
      }),
    });
    const ingestClient = new MediaIngestClient(client, transferStore);

    const first = await ingestClient.ingest(createPngFile(16, 9, "first.png"));
    const registration = platform.sentMessages.find((message) =>
      typeof message === "object" && message !== null && "type" in message && message.type === "media.register",
    );
    expect(registration).toMatchObject({ type: "media.register", payload: { transferId: expect.any(String) } });
    expect((registration as { payload: Record<string, unknown> }).payload).not.toHaveProperty("file");
    expect(first.status).toBe("READY");
    expect(first.aspectRatio).toBeCloseTo(16 / 9);
    expect(imageResources.loaded).toEqual([first.id]);
    expect(events.map((event) => event.type)).toEqual(["media.registered", "media.loading", "media.ready"]);
    expect(events.every(isEventEnvelope)).toBe(true);

    const fetched = await client.send("media.get", { mediaId: first.id });
    const inspected = await client.send("media.inspect", { mediaId: first.id });
    expect(fetched).toEqual(first);
    expect(inspected).toEqual(first);
    expect(await client.send("media.list")).toEqual([first]);

    const released = await client.send("media.remove", { mediaId: first.id });
    expect(released.status).toBe("RELEASED");
    expect(urlApi.revoked).toHaveLength(1);
    expect(events.slice(-2).map((event) => event.type)).toEqual(["media.released", "media.removed"]);
    await expect(client.send("media.get", { mediaId: first.id })).rejects.toMatchObject({
      code: "CAPCAM_MEDIA_ERROR",
      metadata: { mediaCode: "MEDIA_NOT_FOUND" },
    });

    await ingestClient.ingest(createPngFile(4, 3, "second.png"));
    const clear = await client.send("media.clear");
    expect(clear).toEqual({ removed: 1 });
    expect(await client.send("media.list")).toEqual([]);
    expect(urlApi.revoked).toHaveLength(2);
    expect(events.every(isEventEnvelope)).toBe(true);

    const malformed = await backgroundRouter.handle({ protocol: 1, requestId: "bad", type: "media.register", payload: { file: new File(["x"], "x.png") } }, {
      id: "capcam-test",
      url: "chrome-extension://capcam-test/popup.html",
    });
    expect(isResponseEnvelope(malformed)).toBe(true);
    expect(malformed.success).toBe(false);
    if (!malformed.success) expect(malformed.error?.code).toBe("CAPCAM_PROTOCOL_ERROR");
  });

  it("handles valid JPG ingestion and authorizes service worker sender with undefined url", async () => {
    const transferStore = new MemoryTransferStore();
    const imageResources = new FakeImageResources();
    const urlApi = new FakeObjectUrlApi();
    const events: EventEnvelope[] = [];
    const engine = new MediaEngine({
      transferStore,
      imageResources,
      objectUrls: new ObjectUrlManager(urlApi),
      publishEvent: (event) => events.push(event),
    });
    const mediaRuntime = new MediaRuntime(engine);
    const offscreenRuntime = new OffscreenRuntime(mediaRuntime);
    const runtimeManager = offscreenRuntime.manager;
    const offscreenRouter = new CommandRouter({
      authorize: (command) => runtimeManager.authorizeCommand(command.type, command.runtimeSessionId),
      getRuntimeSessionId: () => runtimeManager.getState().runtimeSessionId,
    });
    offscreenRouter.register("runtime.initialize", () => runtimeManager.initialize());
    offscreenRouter.register("runtime.shutdown", () => runtimeManager.shutdown());
    offscreenRouter.register("runtime.reset", () => runtimeManager.reset());
    offscreenRouter.register("runtime.getState", () => runtimeManager.getState());
    offscreenRouter.register("runtime.getDiagnostics", () => runtimeManager.getDiagnostics());
    offscreenRouter.register("runtime.ping", () => runtimeManager.ping());
    offscreenRouter.register("media.register", (payload) => runtimeManager.runSubsystemOperation(() => mediaRuntime.register(payload)));

    const platform = new FakeOffscreenPlatform(offscreenRouter, () => runtimeManager.initialize());
    const offscreenManager = new OffscreenManager(platform);
    const backgroundRuntime = new BackgroundRuntime(offscreenManager, new FakeSettings());
    const backgroundRouter = new BackgroundMessageRouter(
      backgroundRuntime,
      "capcam-test",
      "chrome-extension://capcam-test/",
    );
    const client = new MessagingClient({
      sendMessage: (message) => backgroundRouter.handle(message, {
        id: "capcam-test",
        url: "chrome-extension://capcam-test/popup.html",
      }),
    });
    const ingestClient = new MediaIngestClient(client, transferStore);

    // Create a valid small JPEG header
    const jpegBytes = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x01, 0x00, 0x60, 0x00, 0x60, 0x00, 0x00, 0xFF, 0xD9]);
    const jpegFile = new File([jpegBytes], "photo.jpg", { type: "image/jpeg" });

    const record = await ingestClient.ingest(jpegFile);
    expect(record.status).toBe("READY");
    expect(record.kind).toBe("image");
    expect(record.mimeType).toBe("image/jpeg");
    expect(record.name).toBe("photo.jpg");
  });

  it("handles corrupted/invalid image with a controlled error response", async () => {
    const transferStore = new MemoryTransferStore();
    const imageResources = new FakeImageResources();
    const urlApi = new FakeObjectUrlApi();
    const engine = new MediaEngine({
      transferStore,
      imageResources,
      objectUrls: new ObjectUrlManager(urlApi),
    });
    const mediaRuntime = new MediaRuntime(engine);
    const offscreenRuntime = new OffscreenRuntime(mediaRuntime);
    const runtimeManager = offscreenRuntime.manager;
    const offscreenRouter = new CommandRouter({
      authorize: (command) => runtimeManager.authorizeCommand(command.type, command.runtimeSessionId),
      getRuntimeSessionId: () => runtimeManager.getState().runtimeSessionId,
    });
    offscreenRouter.register("runtime.initialize", () => runtimeManager.initialize());
    offscreenRouter.register("runtime.shutdown", () => runtimeManager.shutdown());
    offscreenRouter.register("runtime.reset", () => runtimeManager.reset());
    offscreenRouter.register("runtime.getState", () => runtimeManager.getState());
    offscreenRouter.register("runtime.getDiagnostics", () => runtimeManager.getDiagnostics());
    offscreenRouter.register("runtime.ping", () => runtimeManager.ping());
    offscreenRouter.register("media.register", (payload) => runtimeManager.runSubsystemOperation(() => mediaRuntime.register(payload)));

    const platform = new FakeOffscreenPlatform(offscreenRouter, () => runtimeManager.initialize());
    const offscreenManager = new OffscreenManager(platform);
    const backgroundRuntime = new BackgroundRuntime(offscreenManager, new FakeSettings());
    const backgroundRouter = new BackgroundMessageRouter(
      backgroundRuntime,
      "capcam-test",
      "chrome-extension://capcam-test/",
    );
    const client = new MessagingClient({
      sendMessage: (message) => backgroundRouter.handle(message, {
        id: "capcam-test",
        url: "chrome-extension://capcam-test/popup.html",
      }),
    });
    const ingestClient = new MediaIngestClient(client, transferStore);

    const corruptFile = new File([new Uint8Array([0x00, 0x01, 0x02, 0x03])], "corrupt.png", { type: "image/png" });
    await expect(ingestClient.ingest(corruptFile)).rejects.toMatchObject({
      code: "CAPCAM_MEDIA_ERROR",
      metadata: { mediaCode: "MEDIA_UNSUPPORTED_TYPE" },
    });
  });
});
