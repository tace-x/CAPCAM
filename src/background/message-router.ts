import { CapCamError } from "../shared/errors";
import type { CapCamSettings } from "../storage/settings";
import { generateRequestId } from "../messaging/commands";
import { CommandRouter } from "../messaging/router";
import { createErrorResponse, extractRequestId, type ResponseEnvelope } from "../messaging/protocol";
import { BackgroundRuntime } from "./runtime";

export interface MessageSenderLike {
  id?: string | undefined;
  url?: string | undefined;
  tab?: unknown | undefined;
}

export interface BackgroundMessageRouterOptions {
  /** Exact offscreen boundary test-page URL; absent from the normal production build. */
  cameraTestPageUrl?: string | null;
}

export class BackgroundMessageRouter {
  private readonly router: CommandRouter;
  private readonly cameraTestPageUrl: string | null;

  constructor(
    private readonly runtime: BackgroundRuntime,
    private readonly extensionId: string,
    private readonly extensionBaseUrl: string,
    options: BackgroundMessageRouterOptions = {},
  ) {
    this.cameraTestPageUrl = options.cameraTestPageUrl ?? null;
    this.router = new CommandRouter({ getRuntimeSessionId: () => this.runtime.getRuntimeSessionId() });
    this.router.register("runtime.getStatus", () => this.runtime.getStatus());
    this.router.register("runtime.initialize", () => this.runtime.initializeMediaRuntime());
    this.router.register("runtime.shutdown", () => this.runtime.shutdownMediaRuntime());
    this.router.register("runtime.reset", () => this.runtime.resetMediaRuntime());
    this.router.register("runtime.getState", () => this.runtime.getRuntimeState());
    this.router.register("runtime.getDiagnostics", () => this.runtime.getRuntimeDiagnostics());
    this.router.register("runtime.ping", () => this.runtime.pingRuntime());
    this.router.register("offscreen.initialize", () => this.runtime.initializeOffscreen());
    this.router.register("offscreen.getStatus", () => this.runtime.getOffscreenStatus());
    this.router.register("offscreen.shutdown", () => this.runtime.shutdown());
    this.router.register("settings.get", () => this.runtime.getSettings());
    this.router.register("settings.update", (payload: Partial<CapCamSettings>) => this.runtime.updateSettings(payload));
    this.router.register("media.register", (payload) => this.runtime.registerMedia(payload));
    this.router.register("media.get", (payload) => this.runtime.getMedia(payload));
    this.router.register("media.list", () => this.runtime.listMedia());
    this.router.register("media.remove", (payload) => this.runtime.removeMedia(payload));
    this.router.register("media.clear", () => this.runtime.clearMedia());
    this.router.register("media.inspect", (payload) => this.runtime.inspectMedia(payload));
    this.router.register("stream.create", (payload) => this.runtime.createStream(payload));
    this.router.register("stream.getState", () => this.runtime.getStreamState());
    this.router.register("stream.start", (payload) => this.runtime.startStream(payload));
    this.router.register("stream.stop", (payload) => this.runtime.stopStream(payload));
    this.router.register("stream.restart", (payload) => this.runtime.restartStream(payload));
    this.router.register("stream.switchSource", (payload) => this.runtime.switchStreamSource(payload));
    this.router.register("stream.getTrackInfo", (payload) => this.runtime.getStreamTrackInfo(payload));
    this.router.register("stream.dispose", (payload) => this.runtime.disposeStream(payload));
    this.router.register("playback.load", (payload) => this.runtime.loadPlayback(payload));
    this.router.register("playback.play", (payload) => this.runtime.playPlayback(payload));
    this.router.register("playback.pause", (payload) => this.runtime.pausePlayback(payload));
    this.router.register("playback.stop", (payload) => this.runtime.stopPlayback(payload));
    this.router.register("playback.restart", (payload) => this.runtime.restartPlayback(payload));
    this.router.register("playback.seek", (payload) => this.runtime.seekPlayback(payload));
    this.router.register("playback.setLoop", (payload) => this.runtime.setPlaybackLoop(payload));
    this.router.register("playback.setRate", (payload) => this.runtime.setPlaybackRate(payload));
    this.router.register("playback.getState", () => this.runtime.getPlaybackState());
    this.router.register("playback.dispose", (payload) => this.runtime.disposePlayback(payload));
    this.router.register("camera.getStatus", () => this.runtime.getCameraIntegrationSnapshot());
    this.router.register("camera.detect", () => this.runtime.detectCameraIntegration());
    this.router.register("camera.enable", () => this.runtime.enableCameraIntegration());
    this.router.register("camera.disable", () => this.runtime.disableCameraIntegration());
    this.router.register("camera.switchSource", (payload) => this.runtime.switchCameraSource(payload.mediaId));
  }

  async handle(message: unknown, sender: MessageSenderLike): Promise<ResponseEnvelope> {
    const requestId = extractRequestId(message) ?? generateRequestId();
    if (!this.isTrustedExtensionPage(sender) && !this.isTrustedCameraTestPage(sender)) {
      return createErrorResponse(
        requestId,
        new CapCamError("CAPCAM_PERMISSION_ERROR", "Messages from this context are not enabled in Phase 01."),
      );
    }
    return this.router.handle(message);
  }

  private isTrustedExtensionPage(sender: MessageSenderLike): boolean {
    return sender.id === this.extensionId &&
      sender.tab === undefined &&
      typeof sender.url === "string" &&
      sender.url.startsWith(this.extensionBaseUrl);
  }

  private isTrustedCameraTestPage(sender: MessageSenderLike): boolean {
    return this.cameraTestPageUrl !== null &&
      sender.id === this.extensionId &&
      sender.url === this.cameraTestPageUrl;
  }
}
