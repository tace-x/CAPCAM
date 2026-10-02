import { toCapCamError } from "../shared/errors";
import { createInitialCapCamState } from "../shared/state";
import { createLogger } from "../shared/logger";
import type { CapCamState, OffscreenRuntimeInfo } from "../shared/types";
import type { CapCamSettings } from "../storage/settings";
import type { OffscreenService } from "./offscreen-manager";

export interface SettingsService {
  getSettings(): Promise<CapCamSettings>;
  updateSettings(patch: Partial<CapCamSettings>): Promise<CapCamSettings>;
}

const logger = createLogger("Runtime");

export class BackgroundRuntime {
  private state: CapCamState = createInitialCapCamState();
  private initialization: Promise<void> | null = null;

  constructor(
    private readonly offscreen: OffscreenService,
    private readonly settings: SettingsService,
  ) {}

  initialize(): Promise<void> {
    if (this.state.runtime.status === "READY" && this.state.offscreen.status === "READY") {
      return Promise.resolve();
    }
    if (this.initialization !== null) return this.initialization;

    this.initialization = this.initializeRuntime().finally(() => {
      this.initialization = null;
    });
    return this.initialization;
  }

  async getStatus(): Promise<CapCamState> {
    await this.initialize();
    try {
      this.state.settings = await this.settings.getSettings();
      const status = await this.offscreen.getStatus();
      this.applyOffscreenInfo(status);
      if (status.status !== "READY") {
        await this.initialize();
        const recoveredStatus = await this.offscreen.getStatus();
        this.applyOffscreenInfo(recoveredStatus);
      }
    } catch (error) {
      const failure = toCapCamError(error);
      this.state.runtime.status = "ERROR";
      if (this.state.offscreen.status !== "READY") this.state.offscreen.status = "ERROR";
      logger.error("Runtime status reconciliation failed.", { code: failure.code });
    }
    return this.copyState();
  }

  async getOffscreenStatus(): Promise<OffscreenRuntimeInfo> {
    const status = await this.offscreen.getStatus();
    this.applyOffscreenInfo(status);
    return { ...status };
  }

  async initializeOffscreen(): Promise<OffscreenRuntimeInfo> {
    await this.initialize();
    const status = await this.offscreen.initialize();
    this.applyOffscreenInfo(status);
    if (status.status === "READY") this.state.runtime.status = "READY";
    return { ...status };
  }

  async shutdown(): Promise<OffscreenRuntimeInfo> {
    const status = await this.offscreen.shutdown();
    this.applyOffscreenInfo(status);
    return { ...status };
  }

  async getSettings(): Promise<CapCamSettings> {
    const settings = await this.settings.getSettings();
    this.state.settings = { ...settings };
    return { ...settings };
  }

  async updateSettings(patch: Partial<CapCamSettings>): Promise<CapCamSettings> {
    const settings = await this.settings.updateSettings(patch);
    this.state.settings = { ...settings };
    return { ...settings };
  }

  private async initializeRuntime(): Promise<void> {
    this.state.runtime.status = "STARTING";
    this.state.offscreen.status = "STARTING";
    try {
      this.state.settings = await this.settings.getSettings();
      const status = await this.offscreen.initialize();
      this.applyOffscreenInfo(status);
      this.state.runtime.status = status.status === "READY" ? "READY" : "ERROR";
      if (status.status === "READY") logger.info("Service worker runtime ready.");
    } catch (error) {
      const failure = toCapCamError(error);
      this.state.runtime.status = "ERROR";
      this.state.offscreen.status = "ERROR";
      logger.error("Service worker runtime initialization failed.", { code: failure.code });
    }
  }

  private applyOffscreenInfo(info: OffscreenRuntimeInfo): void {
    this.state.offscreen.status = info.status;
    if (info.status === "ERROR" && this.state.runtime.status === "READY") {
      this.state.runtime.status = "ERROR";
    }
  }

  private copyState(): CapCamState {
    return {
      runtime: { ...this.state.runtime },
      offscreen: { ...this.state.offscreen },
      media: { ...this.state.media },
      stream: { ...this.state.stream },
      settings: { ...this.state.settings },
    };
  }
}
