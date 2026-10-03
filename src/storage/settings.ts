export type FitMode = "contain" | "cover";

export interface CapCamSettings {
  enabled: boolean;
  fps: number;
  width: number;
  height: number;
  mirror: boolean;
  fitMode: FitMode;
  loop: boolean;
}

export const DEFAULT_SETTINGS: Readonly<CapCamSettings> = Object.freeze({
  enabled: false,
  fps: 30,
  width: 1280,
  height: 720,
  mirror: false,
  fitMode: "contain",
  loop: true,
});

const SETTING_KEYS = ["enabled", "fps", "width", "height", "mirror", "fitMode", "loop"] as const;
type SettingKey = (typeof SETTING_KEYS)[number];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidValue(key: SettingKey, value: unknown): boolean {
  switch (key) {
    case "enabled":
    case "mirror":
    case "loop":
      return typeof value === "boolean";
    case "fps":
      return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 60;
    case "width":
      return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 3840;
    case "height":
      return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 2160;
    case "fitMode":
      return value === "contain" || value === "cover";
  }
}

export function isSettingsPatch(value: unknown): value is Partial<CapCamSettings> {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  if (keys.some((key) => !SETTING_KEYS.includes(key as SettingKey))) return false;
  return keys.every((key) => isValidValue(key as SettingKey, value[key]));
}

export function isCapCamSettings(value: unknown): value is CapCamSettings {
  if (!isRecord(value)) return false;
  if (Object.keys(value).length !== SETTING_KEYS.length) return false;
  return SETTING_KEYS.every((key) => Object.hasOwn(value, key) && isValidValue(key, value[key]));
}

export function normalizeSettings(value: unknown): CapCamSettings {
  if (!isRecord(value)) return { ...DEFAULT_SETTINGS };

  const normalized: CapCamSettings = { ...DEFAULT_SETTINGS };
  for (const key of SETTING_KEYS) {
    const candidate = value[key];
    if (!isValidValue(key, candidate)) continue;
    switch (key) {
      case "enabled":
        if (typeof candidate === "boolean") normalized.enabled = candidate;
        break;
      case "fps":
        if (typeof candidate === "number") normalized.fps = candidate;
        break;
      case "width":
        if (typeof candidate === "number") normalized.width = candidate;
        break;
      case "height":
        if (typeof candidate === "number") normalized.height = candidate;
        break;
      case "mirror":
        if (typeof candidate === "boolean") normalized.mirror = candidate;
        break;
      case "fitMode":
        if (candidate === "contain" || candidate === "cover") normalized.fitMode = candidate;
        break;
      case "loop":
        if (typeof candidate === "boolean") normalized.loop = candidate;
        break;
    }
  }
  return normalized;
}

export function mergeSettings(current: CapCamSettings, patch: Partial<CapCamSettings>): CapCamSettings {
  return { ...current, ...patch };
}
