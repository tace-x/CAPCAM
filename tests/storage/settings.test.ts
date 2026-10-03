import { describe, expect, it } from "vitest";
import { SettingsStorage, type StorageArea } from "../../src/storage/storage";
import { DEFAULT_SETTINGS, type CapCamSettings } from "../../src/storage/settings";
import { SETTINGS_STORAGE_KEY } from "../../src/storage/keys";

class MemoryStorageArea implements StorageArea {
  private readonly values = new Map<string, unknown>();

  async get(key: string): Promise<Record<string, unknown>> {
    const value = this.values.get(key);
    return value === undefined ? {} : { [key]: value };
  }

  async set(items: Record<string, unknown>): Promise<void> {
    for (const [key, value] of Object.entries(items)) this.values.set(key, value);
  }
}

describe("settings storage", () => {
  it("returns documented defaults when no settings have been stored", async () => {
    const storage = new SettingsStorage(new MemoryStorageArea());
    expect(await storage.getSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it("saves and loads settings using the versioned extension-storage key", async () => {
    const area = new MemoryStorageArea();
    const settings: CapCamSettings = { ...DEFAULT_SETTINGS, enabled: true, width: 1920, height: 1080 };
    const firstInstance = new SettingsStorage(area);

    await firstInstance.saveSettings(settings);
    const afterRestart = new SettingsStorage(area);

    expect(await afterRestart.getSettings()).toEqual(settings);
    expect(await area.get(SETTINGS_STORAGE_KEY)).toEqual({ [SETTINGS_STORAGE_KEY]: settings });
  });

  it("updates only supplied values and persists the merged settings", async () => {
    const area = new MemoryStorageArea();
    const storage = new SettingsStorage(area);
    const updated = await storage.updateSettings({ fps: 24, mirror: true });

    expect(updated).toEqual({ ...DEFAULT_SETTINGS, fps: 24, mirror: true });
    expect(await storage.getSettings()).toEqual(updated);
  });
});
