import { DEFAULT_RENDER_CONFIG, RENDER_PRESETS, type RenderConfig, type RenderableMediaSource } from "../canvas/render-types";
import { CanvasStreamPipeline } from "../stream/canvas-stream-pipeline";
import { StreamEngineError } from "../stream/stream-errors";
import { PlaybackEngine } from "../playback/playback-engine";
import type { PlaybackRecord } from "../playback/playback-types";
import type { StreamMediaSourceProvider, TrackInfo } from "../stream/stream-types";
import "./styles.css";

function element<T extends HTMLElement>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (found === null) throw new Error(`Developer harness element was not found: ${selector}`);
  return found;
}

const fileInput = element<HTMLInputElement>("#source-file");
const presetSelect = element<HTMLSelectElement>("#preset");
const fitSelect = element<HTMLSelectElement>("#fit-mode");
const mirrorInput = element<HTMLInputElement>("#mirror");
const createStartButton = element<HTMLButtonElement>("#create-start");
const restartButton = element<HTMLButtonElement>("#restart");
const stopButton = element<HTMLButtonElement>("#stop");
const disposeButton = element<HTMLButtonElement>("#dispose");
const previewVideo = element<HTMLVideoElement>("#preview");
const sourceState = element<HTMLParagraphElement>("#source-state");
const streamState = element<HTMLSpanElement>("#stream-state");
const trackInfo = element<HTMLPreElement>("#track-info");
const canvasMount = element<HTMLDivElement>("#canvas-mount");
const errorBox = element<HTMLParagraphElement>("#error");
const playbackState = element<HTMLSpanElement>("#playback-state");
const playbackLoadButton = element<HTMLButtonElement>("#playback-load");
const playbackPlayButton = element<HTMLButtonElement>("#playback-play");
const playbackPauseButton = element<HTMLButtonElement>("#playback-pause");
const playbackStopButton = element<HTMLButtonElement>("#playback-stop");
const playbackRestartButton = element<HTMLButtonElement>("#playback-restart");
const playbackDisposeButton = element<HTMLButtonElement>("#playback-dispose");
const playbackSeekInput = element<HTMLInputElement>("#playback-seek");
const playbackTime = element<HTMLOutputElement>("#playback-time");
const seekApplyButton = element<HTMLButtonElement>("#seek-apply");
const playbackLoopInput = element<HTMLInputElement>("#playback-loop");
const playbackRateSelect = element<HTMLSelectElement>("#playback-rate");
const imageDurationInput = element<HTMLInputElement>("#image-duration");

for (const preset of RENDER_PRESETS) {
  const option = document.createElement("option");
  option.value = preset.id;
  option.textContent = preset.label;
  presetSelect.append(option);
}
presetSelect.value = RENDER_PRESETS[0]?.id ?? "1280x720@30";
fitSelect.value = DEFAULT_RENDER_CONFIG.fitMode;
mirrorInput.checked = DEFAULT_RENDER_CONFIG.mirror;

let currentSource: RenderableMediaSource | null = null;
let pendingMediaElement: HTMLImageElement | HTMLVideoElement | null = null;
let currentUrl: string | null = null;
let currentPipeline: CanvasStreamPipeline | null = null;
let activeTrack: MediaStreamTrack | null = null;
let activeTrackListeners: Array<{ type: string; listener: EventListener }> = [];
let localSourceCounter = 0;
let active = false;
let busy = false;
let playbackBusy = false;
let playbackRecord: PlaybackRecord | null = null;
let seekDraft: number | null = null;

const sources = new Map<string, RenderableMediaSource>();
const provider: StreamMediaSourceProvider = {
  getRenderableSource(mediaId) {
    const source = sources.get(mediaId);
    if (source === undefined) throw new StreamEngineError("STREAM_SOURCE_UNAVAILABLE", "The developer harness source is not loaded.", { mediaId });
    return source;
  },
};
const playbackEngine = new PlaybackEngine(provider, {
  publishEvent: (event) => {
    if (event.type === "playback.disposed") updatePlayback(null);
    else updatePlayback(event.payload.record);
  },
});

function setError(message: string | null): void {
  errorBox.hidden = message === null;
  errorBox.textContent = message ?? "";
}

function updateButtons(): void {
  const record = playbackRecord;
  const loaded = record !== null;
  createStartButton.disabled = currentSource === null || busy;
  restartButton.disabled = currentPipeline === null || busy;
  stopButton.disabled = currentPipeline === null || !active || busy;
  disposeButton.disabled = currentPipeline === null || busy;
  fileInput.disabled = busy || playbackBusy;
  presetSelect.disabled = busy;
  fitSelect.disabled = busy;
  mirrorInput.disabled = busy;
  playbackLoadButton.disabled = currentSource === null || playbackBusy;
  playbackPlayButton.disabled = !loaded || playbackBusy || record.state === "PLAYING" || record.state === "LOADING" || record.state === "ERROR";
  playbackPauseButton.disabled = !loaded || playbackBusy || record.state !== "PLAYING";
  playbackStopButton.disabled = !loaded || playbackBusy || record.state === "STOPPED" || record.state === "LOADING";
  playbackRestartButton.disabled = !loaded || playbackBusy || record.state === "LOADING" || record.state === "ERROR";
  playbackDisposeButton.disabled = !loaded || playbackBusy;
  playbackLoopInput.disabled = !loaded || playbackBusy;
  playbackRateSelect.disabled = !loaded || playbackBusy;
  imageDurationInput.disabled = currentSource?.kind !== "image" || playbackBusy;
  playbackSeekInput.disabled = !loaded || record.kind !== "video" || record.duration === null || playbackBusy;
  seekApplyButton.disabled = playbackSeekInput.disabled || seekDraft === null || playbackBusy;
}

function setStatus(status: string): void {
  streamState.textContent = status;
  streamState.dataset.state = status.toLowerCase();
}

function formatPlaybackTime(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  const seconds = Math.floor(Math.max(0, value));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function updatePlayback(record: PlaybackRecord | null): void {
  if (playbackRecord?.playbackId !== record?.playbackId) seekDraft = null;
  playbackRecord = record;
  playbackState.textContent = record?.state ?? "IDLE";
  playbackState.dataset.state = (record?.state ?? "idle").toLowerCase();
  playbackLoopInput.checked = record?.loop ?? false;
  playbackRateSelect.value = String(record?.playbackRate ?? 1);
  playbackSeekInput.max = String(record?.duration ?? 0);
  playbackSeekInput.value = String(seekDraft ?? record?.currentTime ?? 0);
  playbackTime.textContent = record?.kind === "image"
    ? `0:00 / ${formatPlaybackTime(record.duration)}`
    : `${formatPlaybackTime(seekDraft ?? record?.currentTime ?? 0)} / ${formatPlaybackTime(record?.duration ?? null)}`;
  updateButtons();
}

function updateTrackSnapshot(info: TrackInfo | null): void {
  if (currentPipeline === null) {
    trackInfo.textContent = "No stream created.";
    return;
  }
  trackInfo.textContent = JSON.stringify({
    streamId: "local-developer-preview",
    sourceMediaId: currentPipeline.sourceMediaId,
    status: active ? "ACTIVE" : "STOPPED",
    track: info,
  }, null, 2);
}

function readConfig(): RenderConfig {
  const preset = RENDER_PRESETS.find((entry) => entry.id === presetSelect.value) ?? RENDER_PRESETS[0];
  if (preset === undefined) throw new StreamEngineError("STREAM_INVALID_CONFIG");
  const fitMode = fitSelect.value;
  if (fitMode !== "cover" && fitMode !== "contain") throw new StreamEngineError("STREAM_INVALID_CONFIG");
  return {
    width: preset.width,
    height: preset.height,
    fps: preset.fps,
    fitMode,
    mirror: mirrorInput.checked,
  };
}

function readPlaybackLoadRequest(): { mediaId: string; imageDurationSeconds?: number } {
  if (currentSource === null) throw new StreamEngineError("STREAM_SOURCE_UNAVAILABLE");
  const durationText = imageDurationInput.value.trim();
  return currentSource.kind === "image" && durationText !== ""
    ? { mediaId: currentSource.mediaId, imageDurationSeconds: Number(durationText) }
    : { mediaId: currentSource.mediaId };
}

async function loadPlaybackSource(): Promise<void> {
  if (currentSource === null) return;
  playbackBusy = true;
  updateButtons();
  setError(null);
  try {
    const record = await playbackEngine.load(readPlaybackLoadRequest());
    updatePlayback(record);
  } catch (error) {
    setError(error instanceof Error ? error.message : "Playback source could not be loaded.");
  } finally {
    playbackBusy = false;
    updateButtons();
  }
}

async function runPlaybackCommand(
  operation: (playbackId: string) => Promise<PlaybackRecord | null>,
): Promise<void> {
  const playbackId = playbackRecord?.playbackId;
  if (playbackId === undefined) return;
  playbackBusy = true;
  updateButtons();
  setError(null);
  try {
    updatePlayback(await operation(playbackId));
  } catch (error) {
    setError(error instanceof Error ? error.message : "Playback command failed.");
    updatePlayback(playbackEngine.getState());
  } finally {
    playbackBusy = false;
    updateButtons();
  }
}

function detachTrackListeners(): void {
  if (activeTrack !== null) {
    for (const { type, listener } of activeTrackListeners) activeTrack.removeEventListener(type, listener);
  }
  activeTrackListeners = [];
  activeTrack = null;
}

function detachPipelinePreview(): void {
  detachTrackListeners();
  previewVideo.pause();
  previewVideo.srcObject = null;
}

function attachPipelinePreview(): void {
  if (currentPipeline === null) return;
  detachTrackListeners();
  previewVideo.srcObject = currentPipeline.getStream();
  previewVideo.muted = true;
  const track = currentPipeline.getTrack();
  activeTrack = track;
  const refreshSnapshot = (): void => {
    if (currentPipeline === null) return;
    try {
      updateTrackSnapshot(currentPipeline.getTrackInfo());
    } catch {
      updateTrackSnapshot(null);
    }
  };
  const listener: EventListener = () => refreshSnapshot();
  for (const type of ["ended", "mute", "unmute"]) {
    track.addEventListener(type, listener);
    activeTrackListeners.push({ type, listener });
  }
  void previewVideo.play().catch((error: unknown) => {
    setError(`The local preview element could not play: ${error instanceof Error ? error.message : "unknown playback error"}`);
  });
  refreshSnapshot();
}

async function clearPipeline(): Promise<void> {
  const pipeline = currentPipeline;
  currentPipeline = null;
  active = false;
  detachPipelinePreview();
  canvasMount.replaceChildren();
  if (pipeline !== null) await pipeline.dispose();
  setStatus("IDLE");
  trackInfo.textContent = "No stream created.";
  updateButtons();
}

async function releaseCurrentSource(): Promise<void> {
  const mediaElement = currentSource?.element ?? pendingMediaElement;
  if (mediaElement !== null && mediaElement !== undefined) {
    if ("pause" in mediaElement) {
      mediaElement.pause();
      mediaElement.removeAttribute("src");
      mediaElement.load();
    } else {
      mediaElement.removeAttribute("src");
    }
  }
  if (currentSource !== null) sources.delete(currentSource.mediaId);
  currentSource = null;
  pendingMediaElement = null;
  if (currentUrl !== null) URL.revokeObjectURL(currentUrl);
  currentUrl = null;
}

function waitForImageLoad(image: HTMLImageElement, url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      window.clearTimeout(timer);
      image.removeEventListener("load", onLoad);
      image.removeEventListener("error", onError);
    };
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error === undefined) resolve();
      else reject(error);
    };
    const onLoad = (): void => finish();
    const onError = (): void => finish(new StreamEngineError("STREAM_SOURCE_UNAVAILABLE", "The selected local image could not decode."));
    const timer = window.setTimeout(() => finish(new StreamEngineError("STREAM_SOURCE_UNAVAILABLE", "Timed out decoding the local image.")), 30_000);
    image.addEventListener("load", onLoad, { once: true });
    image.addEventListener("error", onError, { once: true });
    image.src = url;
    if (image.complete && image.naturalWidth > 0) finish();
  });
}

function waitForVideoMetadata(video: HTMLVideoElement): Promise<void> {
  if (video.readyState >= HTMLMediaElement.HAVE_METADATA && video.videoWidth > 0 && video.videoHeight > 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      cleanup();
      reject(new StreamEngineError("STREAM_SOURCE_UNAVAILABLE", "Timed out reading local video metadata."));
    }, 30_000);
    const cleanup = (): void => {
      window.clearTimeout(timer);
      video.removeEventListener("loadedmetadata", onMetadata);
      video.removeEventListener("error", onError);
    };
    const onMetadata = (): void => {
      cleanup();
      resolve();
    };
    const onError = (): void => {
      cleanup();
      reject(new StreamEngineError("STREAM_SOURCE_UNAVAILABLE", "The selected local video could not load metadata."));
    };
    video.addEventListener("loadedmetadata", onMetadata, { once: true });
    video.addEventListener("error", onError, { once: true });
    video.load();
  });
}

async function loadLocalFile(file: File): Promise<void> {
  setError(null);
  busy = true;
  playbackBusy = true;
  updateButtons();
  try {
    await clearPipeline();
    await playbackEngine.disposeAll();
    await releaseCurrentSource();
    const kind = file.type.startsWith("image/") ? "image" : file.type.startsWith("video/") ? "video" : null;
    if (kind === null) throw new StreamEngineError("STREAM_SOURCE_UNAVAILABLE", "Choose a supported local image or video file.");
    const url = URL.createObjectURL(file);
    currentUrl = url;
    localSourceCounter += 1;
    const mediaId = `med_preview${localSourceCounter.toString().padStart(8, "0")}`;

    if (kind === "image") {
      const image = new Image();
      image.decoding = "async";
      pendingMediaElement = image;
      if (typeof image.decode === "function") {
        image.src = url;
        await image.decode();
      } else {
        await waitForImageLoad(image, url);
      }
      if (image.naturalWidth <= 0 || image.naturalHeight <= 0) throw new StreamEngineError("STREAM_SOURCE_UNAVAILABLE", "Image dimensions are unavailable.");
      currentSource = { mediaId, kind: "image", width: image.naturalWidth, height: image.naturalHeight, element: image };
    } else {
      const video = document.createElement("video");
      video.preload = "metadata";
      video.muted = true;
      video.playsInline = true;
      pendingMediaElement = video;
      video.src = url;
      await waitForVideoMetadata(video);
      if (video.videoWidth <= 0 || video.videoHeight <= 0) throw new StreamEngineError("STREAM_SOURCE_UNAVAILABLE", "Video dimensions are unavailable.");
      currentSource = { mediaId, kind: "video", width: video.videoWidth, height: video.videoHeight, element: video };
    }

    pendingMediaElement = null;
    sources.set(mediaId, currentSource);
    sourceState.textContent = `${file.name} · ${currentSource.width} × ${currentSource.height} · decoded locally`;
    updatePlayback(await playbackEngine.load(readPlaybackLoadRequest()));
    updateButtons();
  } catch (error) {
    await playbackEngine.disposeAll().catch(() => undefined);
    await releaseCurrentSource();
    sourceState.textContent = "No source loaded.";
    setError(error instanceof Error ? error.message : "The selected file could not be decoded.");
  } finally {
    busy = false;
    playbackBusy = false;
    updateButtons();
  }
}

async function createAndStart(): Promise<void> {
  if (currentSource === null) return;
  busy = true;
  updateButtons();
  setError(null);
  try {
    await clearPipeline();
    const pipeline = await CanvasStreamPipeline.create(currentSource.mediaId, readConfig(), provider, (error) => {
      setError(error instanceof Error ? error.message : "Frame rendering failed.");
      active = false;
      detachPipelinePreview();
      setStatus("ERROR");
      updateButtons();
    });
    currentPipeline = pipeline;
    const canvas = pipeline.getCanvas();
    canvasMount.replaceChildren(canvas);
    canvas.className = "render-canvas";
    await pipeline.start();
    active = true;
    attachPipelinePreview();
    setStatus("ACTIVE");
    updateTrackSnapshot(pipeline.getTrackInfo());
  } catch (error) {
    if (currentPipeline !== null) await clearPipeline().catch(() => undefined);
    setStatus("ERROR");
    setError(error instanceof Error ? error.message : "The canvas stream could not start.");
  } finally {
    busy = false;
    updateButtons();
  }
}

async function restartPipeline(): Promise<void> {
  if (currentPipeline === null) return;
  busy = true;
  updateButtons();
  setError(null);
  try {
    await currentPipeline.restart();
    active = true;
    attachPipelinePreview();
    setStatus("ACTIVE");
    updateTrackSnapshot(currentPipeline.getTrackInfo());
  } catch (error) {
    active = false;
    detachPipelinePreview();
    setStatus("ERROR");
    setError(error instanceof Error ? error.message : "The local stream could not restart.");
  } finally {
    busy = false;
    updateButtons();
  }
}

async function stopPipeline(): Promise<void> {
  if (currentPipeline === null) return;
  busy = true;
  updateButtons();
  setError(null);
  try {
    await currentPipeline.stop();
    active = false;
    detachPipelinePreview();
    setStatus("STOPPED");
    updateTrackSnapshot(currentPipeline.getTrackInfo());
  } catch (error) {
    setError(error instanceof Error ? error.message : "The local stream could not stop cleanly.");
  } finally {
    busy = false;
    updateButtons();
  }
}

fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  fileInput.value = "";
  if (file !== undefined) void loadLocalFile(file);
});
createStartButton.addEventListener("click", () => void createAndStart());
restartButton.addEventListener("click", () => void restartPipeline());
stopButton.addEventListener("click", () => void stopPipeline());
playbackLoadButton.addEventListener("click", () => void loadPlaybackSource());
playbackPlayButton.addEventListener("click", () => void runPlaybackCommand((playbackId) => playbackEngine.play({ playbackId })));
playbackPauseButton.addEventListener("click", () => void runPlaybackCommand((playbackId) => playbackEngine.pause({ playbackId })));
playbackStopButton.addEventListener("click", () => void runPlaybackCommand((playbackId) => playbackEngine.stop({ playbackId })));
playbackRestartButton.addEventListener("click", () => void runPlaybackCommand((playbackId) => playbackEngine.restart({ playbackId })));
playbackDisposeButton.addEventListener("click", () => void runPlaybackCommand((playbackId) => playbackEngine.dispose({ playbackId })));
playbackSeekInput.addEventListener("input", () => {
  seekDraft = Number(playbackSeekInput.value);
  updatePlayback(playbackRecord);
});
seekApplyButton.addEventListener("click", () => {
  const time = seekDraft;
  if (time === null) return;
  void runPlaybackCommand((playbackId) => playbackEngine.seek({ playbackId, time })).then(() => {
    seekDraft = null;
    updatePlayback(playbackEngine.getState());
  });
});
playbackLoopInput.addEventListener("change", () => {
  void runPlaybackCommand((playbackId) => playbackEngine.setLoop({ playbackId, enabled: playbackLoopInput.checked }));
});
playbackRateSelect.addEventListener("change", () => {
  const rate = Number(playbackRateSelect.value);
  void runPlaybackCommand((playbackId) => playbackEngine.setPlaybackRate({ playbackId, rate }));
});
disposeButton.addEventListener("click", () => {
  busy = true;
  updateButtons();
  void clearPipeline().then(() => playbackEngine.disposeAll()).then(() => releaseCurrentSource()).catch((error: unknown) => {
    setError(error instanceof Error ? error.message : "Pipeline cleanup failed.");
  }).finally(() => {
    sourceState.textContent = currentSource === null ? "Choose an image or video to begin." : sourceState.textContent;
    busy = false;
    updateButtons();
  });
});

window.addEventListener("pagehide", () => {
  detachPipelinePreview();
  void (async () => {
    if (currentPipeline !== null) await currentPipeline.dispose();
    await playbackEngine.disposeAll();
    await releaseCurrentSource();
  })();
});

updateButtons();
updatePlayback(null);
