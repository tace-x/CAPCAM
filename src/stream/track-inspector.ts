import { StreamEngineError } from "./stream-errors";
import type { TrackInfo, TrackSettingsInfo } from "./stream-types";

function finitePositiveOrNull(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

export class TrackInspector {
  inspect(track: MediaStreamTrack | null): TrackInfo | null {
    if (track === null) return null;
    if (track.kind !== "video") {
      throw new StreamEngineError("STREAM_NO_VIDEO_TRACK", "Only a video track can be inspected by this pipeline.", {
        kind: track.kind,
      });
    }

    let rawSettings: MediaTrackSettings = {};
    try {
      rawSettings = track.getSettings();
    } catch {
      // A browser may not expose capture settings immediately; report unavailable values as null.
    }
    const width = finitePositiveOrNull(rawSettings.width);
    const height = finitePositiveOrNull(rawSettings.height);
    const trackSettings: TrackSettingsInfo = {
      width,
      height,
      frameRate: finitePositiveOrNull(rawSettings.frameRate),
      aspectRatio: finitePositiveOrNull(rawSettings.aspectRatio) ??
        (width !== null && height !== null ? width / height : null),
    };

    return {
      id: track.id,
      label: track.label.slice(0, 128),
      kind: "video",
      readyState: track.readyState,
      enabled: track.enabled,
      muted: track.muted,
      settings: trackSettings,
    };
  }
}
