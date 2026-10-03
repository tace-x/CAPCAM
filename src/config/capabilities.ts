export interface CapCamCapabilities {
  manifestV3: boolean;
  extensionStorage: boolean;
  offscreenDocument: boolean;
  mediaProcessing: false;
  cameraReplacement: false;
}

export function detectCapabilities(): CapCamCapabilities {
  const api = typeof chrome === "undefined" ? undefined : chrome;
  let manifestV3 = false;

  try {
    manifestV3 = api?.runtime?.getManifest().manifest_version === 3;
  } catch {
    manifestV3 = false;
  }

  return {
    manifestV3,
    extensionStorage: Boolean(api?.storage?.local),
    offscreenDocument: Boolean(api?.offscreen?.createDocument),
    mediaProcessing: false,
    cameraReplacement: false,
  };
}
