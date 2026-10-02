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

export class BackgroundMessageRouter {
  private readonly router = new CommandRouter();

  constructor(
    private readonly runtime: BackgroundRuntime,
    private readonly extensionId: string,
    private readonly extensionBaseUrl: string,
  ) {
    this.router.register("runtime.getStatus", () => this.runtime.getStatus());
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
  }

  async handle(message: unknown, sender: MessageSenderLike): Promise<ResponseEnvelope> {
    const requestId = extractRequestId(message) ?? generateRequestId();
    if (!this.isTrustedExtensionPage(sender)) {
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
}
