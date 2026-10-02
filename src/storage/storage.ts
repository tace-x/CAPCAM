import { CapCamError } from "../shared/errors";
import { SETTINGS_STORAGE_KEY } from "./keys";
import {
  DEFAULT_SETTINGS,
  isCapCamSettings,
  isSettingsPatch,
  mergeSettings,
  normalizeSettings,
  type CapCamSettings,
} from "./settings";

export interface StorageArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

function createChromeStorageArea(): StorageArea {
  if (typeof chrome === "undefined" || chrome.storage?.local === undefined) {
    throw new CapCamError("CAPCAM_STORAGE_ERROR", "Chrome local storage is not available.");
  }

  return {
    get: async (key) => chrome.storage.local.get(key),
    set: async (items) => chrome.storage.local.set(items),
  };
}

function storageFailure(action: "load" | "save", error: unknown): CapCamError {
  if (error instanceof CapCamError && error.code === "CAPCAM_STORAGE_ERROR") return error;
  const reason = error instanceof Error ? error.message : "Unknown storage failure.";
  const message = action === "load" ? "Unable to load CapCam settings." : "Unable to save CapCam settings.";
  return new CapCamError("CAPCAM_STORAGE_ERROR", message, { reason });
}

export class SettingsStorage {
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly area: StorageArea = createChromeStorageArea()) {}

  async getSettings(): Promise<CapCamSettings> {
    try {
      const stored = await this.area.get(SETTINGS_STORAGE_KEY);
      const value = stored[SETTINGS_STORAGE_KEY];
      return normalizeSettings(value);
    } catch (error) {
      throw storageFailure("load", error);
    }
  }

  async saveSettings(settings: CapCamSettings): Promise<CapCamSettings> {
    if (!isCapCamSettings(settings)) {
      throw new CapCamError("CAPCAM_STORAGE_ERROR", "Settings contain unsupported values.");
    }
    const copy = { ...settings };
    return this.serializeWrite(async () => {
      await this.write(copy);
      return { ...copy };
    });
  }

  async updateSettings(patch: Partial<CapCamSettings>): Promise<CapCamSettings> {
    if (!isSettingsPatch(patch)) {
      throw new CapCamError("CAPCAM_STORAGE_ERROR", "Settings update contains unsupported values.");
    }
    return this.serializeWrite(async () => {
      const current = await this.getSettings();
      const updated = mergeSettings(current, patch);
      await this.write(updated);
      return { ...updated };
    });
  }

  private async write(settings: CapCamSettings): Promise<void> {
    try {
      await this.area.set({ [SETTINGS_STORAGE_KEY]: settings });
    } catch (error) {
      throw storageFailure("save", error);
    }
  }

  private serializeWrite<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writeQueue.then(operation, operation);
    this.writeQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export { DEFAULT_SETTINGS };
