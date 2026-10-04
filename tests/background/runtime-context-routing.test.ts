import { describe, expect, it } from "vitest";
import { BackgroundMessageRouter } from "../../src/background/message-router";
import { OffscreenManager, type OffscreenPlatform } from "../../src/background/offscreen-manager";
import { BackgroundRuntime } from "../../src/background/runtime";
import { MediaEngine } from "../../src/media/media-engine";
import { MediaIngestClient } from "../../src/media/media-ingest-client";
import { ObjectUrlManager, type ObjectUrlApi } from "../../src/media/object-url-manager";
import type { ImageElementLike, ImageResourceManagerPort } from "../../src/media/image-resource-manager";
import type { ImageResourceInfo } from "../../src/media/media-types";
import type { MediaTransferStore } from "../../src/media/media-transfer-store";
import { MessagingClient } from "../../src/messaging/client";
import { CommandRouter } from "../../src/messaging/router";
import { isEventEnvelope } from "../../src/messaging/protocol";
import { MediaRuntime } from "../../src/offscreen/media-runtime";
import { OffscreenRuntime } from "../../src/offscreen/runtime";
import { DEFAULT_SETTINGS, type CapCamSettings } from "../../src/storage/settings";
import type { EventEnvelope } from "../../src/messaging/events";
import { isAuthorizedOffscreenCommandSender } from "../../src/offscreen/authorized-sender";
import { StreamManager } from "../../src/stream/stream-manager";
import { CanvasStreamPipelineFactory } from "../../src/stream/canvas-stream-pipeline";
import { CanvasManager } from "../../src/canvas/canvas-manager";
import { PlaybackEngine } from "../../src/playback/playback-engine";
import { createFakeCanvasFixture, FakeStreamFactory } from "../stream/fakes";

class MemoryTransferStore implements MediaTransferStore {
  private readonly files = new Map<string, File>();
  private nextId = 0;

  async stage(file: File): Promise<string> {
    this.nextId += 1;
    const transferId = `transfer_ctx${this.nextId.toString().padStart(6, "0")}`;
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

  getImageElement(_mediaId: string): ImageElementLike {
    return {
      src: "blob:fake",
      complete: true,
      naturalWidth: 1600,
      naturalHeight: 900,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      removeAttribute: () => undefined,
    };
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

class FakeSettings {
  private settings: CapCamSettings = { ...DEFAULT_SETTINGS };

  async getSettings(): Promise<CapCamSettings> {
    return { ...this.settings };
  }

  async updateSettings(patch: Partial<CapCamSettings>): Promise<CapCamSettings> {
    this.settings = { ...this.settings, ...patch };
    return { ...this.settings };
  }
}

describe("Popup → Background → Offscreen Protocol & Routing Isolation", () => {
  const extensionId = "capcam-test-ext";
  const extensionBaseUrl = `chrome-extension://${extensionId}/`;
  const backgroundUrl = `${extensionBaseUrl}background.js`;
  const popupSender = { id: extensionId, url: `${extensionBaseUrl}popup.html` };
  const swSender = { id: extensionId, url: undefined };

  function setupEnvironment() {
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
    const canvasFixture = createFakeCanvasFixture();
    const streamFactory = new FakeStreamFactory();
    const pipelineFactory = new CanvasStreamPipelineFactory(engine, {
      createCanvasManager: () => new CanvasManager(() => canvasFixture.canvas),
      streamFactory,
    });
    const streams = new StreamManager(pipelineFactory, { publishEvent: (event) => events.push(event) });
    const playback = new PlaybackEngine(engine, { publishEvent: (event) => events.push(event) });
    const mediaRuntime = new MediaRuntime(engine, streams, playback);
    const offscreenRuntime = new OffscreenRuntime(mediaRuntime, { publishEvent: (event) => events.push(event) });
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
    offscreenRouter.register("stream.create", (payload) => runtimeManager.runSubsystemOperation(() => mediaRuntime.createStream(payload)));
    offscreenRouter.register("stream.getState", () => runtimeManager.runSubsystemOperation(() => mediaRuntime.getStreamState()));
    offscreenRouter.register("stream.start", (payload) => runtimeManager.runSubsystemOperation(() => mediaRuntime.startStream(payload)));

    // Emulate Chrome extension bus with both Background and Offscreen listeners active
    let documentExists = false;

    // Offscreen onMessage listener
    const offscreenOnMessage = async (message: unknown, sender: typeof popupSender | typeof swSender) => {
      if (!isAuthorizedOffscreenCommandSender(sender, extensionId, backgroundUrl) || isEventEnvelope(message)) {
        return undefined; // Not handled by offscreen
      }
      return offscreenRouter.handle(message);
    };

    const platform: OffscreenPlatform = {
      hasDocument: async () => documentExists,
      createDocument: async () => {
        documentExists = true;
        await runtimeManager.initialize();
      },
      closeDocument: async () => {
        documentExists = false;
        await runtimeManager.shutdown();
      },
      sendMessage: async (message) => {
        // Sent from Background Service Worker (swSender: url is undefined)
        const response = await offscreenOnMessage(message, swSender);
        if (response === undefined) throw new Error("Offscreen did not handle service-worker command.");
        return response;
      },
    };

    const offscreenManager = new OffscreenManager(platform);
    const backgroundRuntime = new BackgroundRuntime(offscreenManager, new FakeSettings());
    const backgroundRouter = new BackgroundMessageRouter(backgroundRuntime, extensionId, extensionBaseUrl);

    // Background onMessage listener
    const backgroundOnMessage = async (message: unknown, sender: typeof popupSender | typeof swSender) => {
      if (!backgroundRouter.isTrustedSender(sender) || isEventEnvelope(message)) {
        return undefined; // Not handled by background
      }
      return backgroundRouter.handle(message, sender);
    };

    // Chrome bus: simulates chrome.runtime.sendMessage broadcast from Popup
    const chromeBroadcastFromPopup = async (message: unknown): Promise<unknown> => {
      // Both listeners receive the broadcast
      const offscreenResult = await offscreenOnMessage(message, popupSender);
      const backgroundResult = await backgroundOnMessage(message, popupSender);

      // In the bug scenario, offscreen handled it and returned UNKNOWN_COMMAND error.
      // With the fix, offscreen returns undefined (ignores), and background returns the real response.
      if (offscreenResult !== undefined) {
        return offscreenResult;
      }
      if (backgroundResult !== undefined) {
        return backgroundResult;
      }
      throw new Error("No extension listener responded to the command.");
    };

    const client = new MessagingClient({ sendMessage: chromeBroadcastFromPopup });
    const ingestClient = new MediaIngestClient(client, transferStore);

    return {
      client,
      ingestClient,
      backgroundRuntime,
      runtimeManager,
      offscreenManager,
      transferStore,
      platform,
    };
  }

  it("handles popup runtime.getStatus without offscreen context collision", async () => {
    const env = setupEnvironment();

    // In the previous bug, offscreen intercepted runtime.getStatus and threw UNKNOWN_COMMAND:
    // "Command is not available in this runtime context."
    // With the fix, offscreen ignores the popup sender and background responds with READY state.
    const status = await env.client.send("runtime.getStatus");
    expect(status.runtime.status).toBe("READY");
    expect(status.offscreen.status).toBe("READY");
    expect(status.stream.status).toBe("IDLE");
  });

  it("completes full upload media -> register -> stream create -> start pipeline", async () => {
    const env = setupEnvironment();

    // 1. Initial status check
    const status = await env.client.send("runtime.getStatus");
    expect(status.runtime.status).toBe("READY");

    // 2. Upload valid image
    const jpegBytes = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x01, 0x00, 0x60, 0x00, 0x60, 0x00, 0x00, 0xFF, 0xD9]);
    const file = new File([jpegBytes], "photo.jpg", { type: "image/jpeg" });
    const record = await env.ingestClient.ingest(file);
    expect(record.status).toBe("READY");
    expect(record.kind).toBe("image");

    // 3. Create stream
    const stream = await env.client.send("stream.create", {
      mediaId: record.id,
      config: { width: 1280, height: 720, fps: 30, fitMode: "contain", mirror: false },
    });
    expect(stream.state).toBe("READY");

    expect(stream.streamId).not.toBeNull();
    const started = await env.client.send("stream.start", { streamId: stream.streamId ?? "" });
    expect(started.state).toBe("ACTIVE");
  });

  it("recovers gracefully after offscreen runtime restart and registers media with new session", async () => {
    const env = setupEnvironment();

    // Initialize first session
    await env.client.send("runtime.getStatus");
    const initialSession = env.runtimeManager.getState().runtimeSessionId;

    // Reset/restart offscreen runtime, generating a new session ID
    await env.runtimeManager.reset();
    const rotatedSession = env.runtimeManager.getState().runtimeSessionId;
    expect(rotatedSession).not.toBe(initialSession);

    // Upload another image after restart — should automatically synchronize and succeed
    const jpegBytes = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x01, 0x00, 0x60, 0x00, 0x60, 0x00, 0x00, 0xFF, 0xD9]);
    const file2 = new File([jpegBytes], "photo2.jpg", { type: "image/jpeg" });
    const record2 = await env.ingestClient.ingest(file2);
    expect(record2.status).toBe("READY");
  });
});
