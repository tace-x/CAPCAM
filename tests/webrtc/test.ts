import { DEFAULT_RENDER_CONFIG, type RenderConfig, type RenderableMediaSource } from "../../src/canvas/render-types";
import { MediaIngestClient } from "../../src/media/media-ingest-client";
import type { MediaRecord } from "../../src/media/media-types";
import { MessagingClient } from "../../src/messaging/client";
import { OFFSCREEN_STREAM_BRIDGE_CHANNEL, isOffscreenStreamBridgeResponse } from "../../src/shared/camera-test-bridge";
import { CameraIntegration, detectBrowserCameraApis, type CameraIntegrationStatus } from "./camera-integration";
import {
  isLocalConsumerDiagnosticMessage,
  isLocalConsumerDisposeMessage,
  isLocalConsumerDisposedMessage,
  isLocalConsumerInspectMessage,
  isLocalConsumerInspectedMessage,
  isLocalConsumerReceivedMessage,
  isLocalConsumerReadyMessage,
  isLocalConsumerStreamMessage,
  LOCAL_CONSUMER_PROTOCOL_VERSION,
  type LocalConsumerDiagnosticMessage,
  type LocalConsumerDisposedMessage,
  type LocalConsumerFrameEvidence,
  type LocalConsumerInspectedMessage,
  type LocalConsumerTrackSnapshot,
} from "./local-consumer-protocol";
import { CanvasStreamPipeline } from "../../src/stream/canvas-stream-pipeline";
import type { StreamInfo, StreamMediaSourceProvider } from "../../src/stream/stream-types";
import type { PlaybackRecord } from "../../src/playback/playback-types";
import "./webrtc.css";

type LogFunction = (message: string, details?: unknown) => void;
type SourceRecord = { source: RenderableMediaSource; objectUrl: string; fileName: string };

const MAX_LOCAL_FILE_BYTES = 512 * 1024 * 1024;
const TRANSFER_MESSAGE = "capcam.webrtc.stream-probe";
const TRANSFER_RESULT_MESSAGE = "capcam.webrtc.stream-probe-result";
const RECEIVER_READY_MESSAGE = "capcam.webrtc.receiver-ready";
const PHASE06_LOCAL_CONSUMER_URL = "http://localhost:5173/tests/webrtc/web-consumer.html";
const CONSUMER_READY_TIMEOUT_MS = 8_000;
const CONSUMER_RECEIPT_TIMEOUT_MS = 10_000;
const CONSUMER_INSPECT_TIMEOUT_MS = 2_500;

type VerificationVerdict = "PASS" | "FAIL" | "BLOCKED" | "UNVERIFIED";
type Phase06CheckId =
  | "playback"
  | "mediaStreamCreation"
  | "videoTrackCreation"
  | "offscreenCommunication"
  | "consumerConnection"
  | "frameReception"
  | "trackLifecycle"
  | "cleanup";

type Phase06Check = {
  status: VerificationVerdict;
  updatedAt: string | null;
  observation: string;
  evidence: Record<string, unknown> | null;
};

type Phase06DiagnosticEvent = {
  type: "consumer-track-ended" | "consumer-disconnected" | "consumer-window-closed";
  observedAt: string;
  requestId: string | null;
  evidence: Record<string, unknown>;
};

function element<T extends HTMLElement>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (found === null) throw new Error(`Test page is missing ${selector}.`);
  return found;
}

function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordLog(message: string, details?: unknown): void {
  const log = document.querySelector<HTMLElement>("#log");
  if (log === null) return;
  const detailText = details === undefined ? "" : `\n${JSON.stringify(details, null, 2)}`;
  const line = `${new Date().toISOString()}  ${message}${detailText}`;
  log.textContent = `${line}\n\n${log.textContent ?? ""}`.trimEnd();
}

function setStatus(selector: string, text: string): void {
  const target = document.querySelector<HTMLElement>(selector);
  if (target !== null) target.textContent = text;
}

function trackSnapshot(track: MediaStreamTrack): Record<string, unknown> {
  const settings = track.getSettings();
  const numericSetting = (value: number | undefined): number | null =>
    typeof value === "number" && Number.isFinite(value) ? value : null;
  return {
    kind: track.kind,
    id: track.id,
    label: track.label,
    readyState: track.readyState,
    enabled: track.enabled,
    muted: track.muted,
    // Keep browser-specific identifiers such as deviceId out of test messages and logs.
    settings: {
      width: numericSetting(settings.width),
      height: numericSetting(settings.height),
      frameRate: numericSetting(settings.frameRate),
      aspectRatio: numericSetting(settings.aspectRatio),
    },
  };
}

async function samplePresentedFrames(
  video: HTMLVideoElement,
  sampleDurationMs = 1_200,
): Promise<LocalConsumerFrameEvidence> {
  const track = video.srcObject instanceof MediaStream ? video.srcObject.getVideoTracks()[0] ?? null : null;
  const supported = typeof video.requestVideoFrameCallback === "function";
  const startedAt = performance.now();
  if (!supported) {
    return {
      frameCallbackSupported: false,
      frameCount: 0,
      firstMediaTime: null,
      lastMediaTime: null,
      videoWidth: video.videoWidth,
      videoHeight: video.videoHeight,
      videoReadyState: video.readyState,
      paused: video.paused,
      trackReadyState: track?.readyState ?? "ended",
      sampledDurationMs: 0,
    };
  }

  return new Promise((resolve) => {
    let frameCount = 0;
    let firstMediaTime: number | null = null;
    let lastMediaTime: number | null = null;
    let callbackId: number | null = null;
    let timer: number | null = null;
    let settled = false;

    const finish = (): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) window.clearTimeout(timer);
      if (callbackId !== null) {
        try {
          video.cancelVideoFrameCallback(callbackId);
        } catch {
          // The callback may have completed while the stream was being detached.
        }
      }
      resolve({
        frameCallbackSupported: true,
        frameCount,
        firstMediaTime,
        lastMediaTime,
        videoWidth: video.videoWidth,
        videoHeight: video.videoHeight,
        videoReadyState: video.readyState,
        paused: video.paused,
        trackReadyState: track?.readyState ?? "ended",
        sampledDurationMs: Math.min(6_000, Math.round(performance.now() - startedAt)),
      });
    };
    const onFrame = (_now: DOMHighResTimeStamp, metadata: VideoFrameCallbackMetadata): void => {
      if (settled) return;
      frameCount = Math.min(10_000, frameCount + 1);
      if (firstMediaTime === null) firstMediaTime = metadata.mediaTime;
      lastMediaTime = metadata.mediaTime;
      if (performance.now() - startedAt >= sampleDurationMs) {
        finish();
      } else {
        callbackId = video.requestVideoFrameCallback(onFrame);
      }
    };

    timer = window.setTimeout(finish, sampleDurationMs + 1_000);
    callbackId = video.requestVideoFrameCallback(onFrame);
  });
}

function displayTrack(selector: string, stream: MediaStream | null): void {
  const target = document.querySelector<HTMLElement>(selector);
  if (target === null) return;
  if (stream === null) {
    target.textContent = "No MediaStream is currently attached.";
    return;
  }
  target.textContent = JSON.stringify({
    streamId: stream.id,
    active: stream.active,
    tracks: stream.getTracks().map(trackSnapshot),
  }, null, 2);
}

function stopTracks(stream: MediaStream | null): void {
  if (stream === null) return;
  for (const track of stream.getTracks()) track.stop();
}

function guardedTask(label: string, task: () => Promise<void>): void {
  void task().catch((error: unknown) => {
    recordLog(`${label} failed`, { error: errorText(error) });
    setStatus("#stream-status", `${label} failed`);
    setStatus("#camera-status", `${label} failed`);
  });
}

async function decodeLocalFile(file: File): Promise<SourceRecord> {
  if (file.size <= 0 || file.size > MAX_LOCAL_FILE_BYTES) {
    throw new Error("Choose a non-empty image or video no larger than 512 MiB.");
  }
  const kind = file.type.startsWith("image/") ? "image" : file.type.startsWith("video/") ? "video" : null;
  if (kind === null) throw new Error("Choose a browser-supported local image or video file.");
  const objectUrl = URL.createObjectURL(file);
  const mediaId = `webrtc_${crypto.randomUUID()}`;

  try {
    if (kind === "image") {
      const image = new Image();
      image.decoding = "async";
      image.src = objectUrl;
      await image.decode();
      if (image.naturalWidth <= 0 || image.naturalHeight <= 0) throw new Error("The image has no decoded dimensions.");
      return {
        source: { mediaId, kind, width: image.naturalWidth, height: image.naturalHeight, element: image },
        objectUrl,
        fileName: file.name,
      };
    }

    const video = document.createElement("video");
    video.preload = "metadata";
    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    await waitForVideoMetadata(video, objectUrl);
    if (video.videoWidth <= 0 || video.videoHeight <= 0) throw new Error("The video has no decoded dimensions.");
    return {
      source: { mediaId, kind, width: video.videoWidth, height: video.videoHeight, element: video },
      objectUrl,
      fileName: file.name,
    };
  } catch (error) {
    URL.revokeObjectURL(objectUrl);
    throw error;
  }
}

function waitForVideoMetadata(video: HTMLVideoElement, objectUrl: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = window.setTimeout(() => finish(new Error("Timed out decoding local video metadata.")), 30_000);
    const cleanup = (): void => {
      window.clearTimeout(timer);
      video.removeEventListener("loadedmetadata", onMetadata);
      video.removeEventListener("error", onError);
    };
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error === undefined) resolve();
      else reject(error);
    };
    const onMetadata = (): void => finish();
    const onError = (): void => finish(new Error("The selected local video could not be decoded."));
    video.addEventListener("loadedmetadata", onMetadata, { once: true });
    video.addEventListener("error", onError, { once: true });
    video.src = objectUrl;
    video.load();
    if (video.readyState >= HTMLMediaElement.HAVE_METADATA && video.videoWidth > 0 && video.videoHeight > 0) finish();
  });
}

class PageGeneratedMediaSession {
  private readonly sources = new Map<string, SourceRecord>();
  private currentSource: SourceRecord | null = null;
  private pipeline: CanvasStreamPipeline | null = null;
  private sourceSequence = 0;

  constructor(
    private readonly canvasMount: HTMLElement | null,
    private readonly log: LogFunction,
  ) {}

  get hasSource(): boolean {
    return this.currentSource !== null;
  }

  get hasPipeline(): boolean {
    return this.pipeline !== null;
  }

  get sourceName(): string | null {
    return this.currentSource?.fileName ?? null;
  }

  async addSource(file: File): Promise<SourceRecord> {
    const decoded = await decodeLocalFile(file);
    this.sourceSequence += 1;
    const source: SourceRecord = {
      ...decoded,
      source: { ...decoded.source, mediaId: `${decoded.source.mediaId}_${this.sourceSequence}` },
    };
    this.sources.set(source.source.mediaId, source);
    if (this.currentSource === null) this.currentSource = source;
    return source;
  }

  async selectSource(next: SourceRecord): Promise<void> {
    const previous = this.currentSource;
    if (this.pipeline !== null) {
      if (previous?.source.kind === "video") previous.source.element.pause();
      await this.pipeline.switchSource(next.source.mediaId);
    }
    this.currentSource = next;
    await this.playCurrentVideo();
  }

  async start(): Promise<MediaStream> {
    const source = this.requireSource();
    if (this.pipeline !== null) throw new Error("A stream pipeline already exists. Use Restart or Dispose first.");
    await this.playCurrentVideo();
    const config: RenderConfig = { ...DEFAULT_RENDER_CONFIG, width: 1280, height: 720, fps: 30 };
    const provider: StreamMediaSourceProvider = {
      getRenderableSource: (mediaId) => {
        const record = this.sources.get(mediaId);
        if (record === undefined) throw new Error(`Local page source ${mediaId} is unavailable.`);
        return record.source;
      },
    };
    const pipeline = await CanvasStreamPipeline.create(source.source.mediaId, config, provider, (error) => {
      this.log("Canvas renderer reported an error.", { error: errorText(error) });
    });
    this.pipeline = pipeline;
    this.canvasMount?.replaceChildren(pipeline.getCanvas());
    try {
      await pipeline.start();
      const stream = pipeline.getStream();
      this.log("Page-owned CapCam canvas stream started.", {
        source: source.fileName,
        track: trackSnapshot(pipeline.getTrack()),
      });
      return stream;
    } catch (error) {
      await this.disposeStream().catch(() => undefined);
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.pipeline === null) throw new Error("There is no stream pipeline to stop.");
    await this.pipeline.stop();
  }

  async restart(): Promise<MediaStream> {
    if (this.pipeline === null) throw new Error("Create a stream before restarting it.");
    await this.playCurrentVideo();
    await this.pipeline.restart();
    const stream = this.pipeline.getStream();
    this.log("Capture stream restarted with a new browser track.", {
      source: this.currentSource?.fileName,
      track: trackSnapshot(this.pipeline.getTrack()),
    });
    return stream;
  }

  async switchSource(next: SourceRecord): Promise<MediaStream | null> {
    await this.selectSource(next);
    if (this.pipeline === null) return null;
    const stream = this.pipeline.getStream();
    this.log("Active renderer source switched; the existing capture pipeline was retained.", {
      source: next.fileName,
      track: trackSnapshot(this.pipeline.getTrack()),
    });
    return stream;
  }

  async pauseSource(): Promise<void> {
    const source = this.requireSource();
    if (source.source.kind === "video") source.source.element.pause();
    const track = this.pipeline?.getTrack();
    this.log("Source playback paused independently of stream lifecycle.", {
      captureTrackReadyState: track?.readyState ?? "no stream",
      schedulerRendering: this.pipeline?.isRendering() ?? false,
    });
  }

  async resumeSource(): Promise<void> {
    await this.playCurrentVideo();
    const track = this.pipeline?.getTrack();
    this.log("Source playback resumed independently of stream lifecycle.", {
      captureTrackReadyState: track?.readyState ?? "no stream",
      schedulerRendering: this.pipeline?.isRendering() ?? false,
    });
  }

  getStream(): MediaStream {
    if (this.pipeline === null) throw new Error("There is no generated stream yet.");
    return this.pipeline.getStream();
  }

  getTrack(): MediaStreamTrack {
    if (this.pipeline === null) throw new Error("There is no generated stream yet.");
    return this.pipeline.getTrack();
  }

  async disposeStream(): Promise<void> {
    const pipeline = this.pipeline;
    this.pipeline = null;
    if (pipeline !== null) await pipeline.dispose();
    this.canvasMount?.replaceChildren();
  }

  async cleanup(): Promise<void> {
    await this.disposeStream();
    for (const record of this.sources.values()) {
      if (record.source.kind === "video") {
        record.source.element.pause();
        record.source.element.removeAttribute("src");
        record.source.element.load();
      } else if ("removeAttribute" in record.source.element && typeof (record.source.element as HTMLImageElement).removeAttribute === "function") {
        (record.source.element as HTMLImageElement).removeAttribute("src");
      } else if ("close" in record.source.element && typeof (record.source.element as ImageBitmap).close === "function") {
        (record.source.element as ImageBitmap).close();
      }
      URL.revokeObjectURL(record.objectUrl);
    }
    this.sources.clear();
    this.currentSource = null;
  }

  private requireSource(): SourceRecord {
    if (this.currentSource === null) throw new Error("Choose and decode a local image or video first.");
    return this.currentSource;
  }

  private async playCurrentVideo(): Promise<void> {
    const source = this.currentSource;
    if (source?.source.kind === "video") {
      source.source.element.muted = true;
      source.source.element.playsInline = true;
      await source.source.element.play();
    }
  }
}

function setupBasicCamera(): void {
  const startButton = element<HTMLButtonElement>("#start-camera");
  const stopButton = element<HTMLButtonElement>("#stop-camera");
  const preview = element<HTMLVideoElement>("#camera-preview");
  const getUserMedia = navigator.mediaDevices?.getUserMedia;
  let cameraStream: MediaStream | null = null;

  setStatus("#camera-status", typeof getUserMedia === "function" ? "Ready · native getUserMedia available" : "Unavailable · secure context required");
  startButton.addEventListener("click", () => guardedTask("Native camera request", async () => {
    if (typeof getUserMedia !== "function") throw new Error("navigator.mediaDevices.getUserMedia is unavailable in this context.");
    if (cameraStream !== null) throw new Error("Stop the current camera stream before starting another.");
    recordLog("Calling the unmodified native getUserMedia({ audio: false, video: true }).");
    cameraStream = await getUserMedia.call(navigator.mediaDevices, { audio: false, video: true });
    const track = cameraStream.getVideoTracks()[0];
    if (track === undefined) throw new Error("The browser returned no video track.");
    preview.srcObject = cameraStream;
    await preview.play();
    displayTrack("#track-info", cameraStream);
    setStatus("#camera-status", `Active · ${track.readyState}`);
    startButton.disabled = true;
    stopButton.disabled = false;
    for (const eventType of ["ended", "mute", "unmute"]) {
      track.addEventListener(eventType, () => {
        displayTrack("#track-info", cameraStream);
        recordLog(`Native camera track event: ${eventType}.`, trackSnapshot(track));
      });
    }
    recordLog("Native camera stream is attached to the page-visible video element.", trackSnapshot(track));
  }));

  stopButton.addEventListener("click", () => {
    stopTracks(cameraStream);
    cameraStream = null;
    preview.pause();
    preview.srcObject = null;
    displayTrack("#track-info", null);
    startButton.disabled = false;
    stopButton.disabled = true;
    setStatus("#camera-status", "Stopped · local tracks released");
    recordLog("Native camera tracks stopped and the preview detached.");
  });

  window.addEventListener("pagehide", () => stopTracks(cameraStream));
}

function setupCapcamStream(): void {
  const sourceInput = element<HTMLInputElement>("#source-file");
  const switchInput = element<HTMLInputElement>("#switch-file");
  const createButton = element<HTMLButtonElement>("#create-stream");
  const switchButton = element<HTMLButtonElement>("#switch-source");
  const pauseButton = element<HTMLButtonElement>("#pause-source");
  const resumeButton = element<HTMLButtonElement>("#resume-source");
  const stopButton = element<HTMLButtonElement>("#stop-stream");
  const restartButton = element<HTMLButtonElement>("#restart-stream");
  const disposeButton = element<HTMLButtonElement>("#dispose-stream");
  const probeButton = element<HTMLButtonElement>("#probe-transfer");
  const preview = element<HTMLVideoElement>("#stream-preview");
  const iframe = element<HTMLIFrameElement>("#transfer-target");
  const session = new PageGeneratedMediaSession(element<HTMLDivElement>("#canvas-mount"), recordLog);
  let pendingSwitch: SourceRecord | null = null;
  let receiverReady = false;
  let pendingProbeId: string | null = null;
  let probeTimer: number | null = null;

  const attachStream = async (stream: MediaStream): Promise<void> => {
    preview.srcObject = stream;
    await preview.play();
    displayTrack("#track-info", stream);
  };

  sourceInput.addEventListener("change", () => {
    const file = sourceInput.files?.[0];
    if (file === undefined) return;
    guardedTask("Local source decode", async () => {
      const source = await session.addSource(file);
      setStatus("#stream-status", `Loaded · ${source.fileName} · ${source.source.width}×${source.source.height}`);
      createButton.disabled = session.hasPipeline;
      recordLog("Local file decoded in this page; it has not been sent through extension messaging.", {
        fileName: source.fileName,
        kind: source.source.kind,
        width: source.source.width,
        height: source.source.height,
        bytes: file.size,
      });
    });
  });

  switchInput.addEventListener("change", () => {
    const file = switchInput.files?.[0];
    if (file === undefined) return;
    guardedTask("Switch source decode", async () => {
      pendingSwitch = await session.addSource(file);
      switchButton.disabled = false;
      setStatus("#stream-status", `Switch ready · ${pendingSwitch.fileName}`);
      recordLog("Second local source decoded; switch it explicitly to compare track identity.", {
        fileName: pendingSwitch.fileName,
        kind: pendingSwitch.source.kind,
      });
    });
  });

  createButton.addEventListener("click", () => guardedTask("Create stream", async () => {
    const stream = await session.start();
    await attachStream(stream);
    createButton.disabled = true;
    switchInput.disabled = false;
    pauseButton.disabled = false;
    resumeButton.disabled = false;
    stopButton.disabled = false;
    restartButton.disabled = false;
    disposeButton.disabled = false;
    probeButton.disabled = !receiverReady;
    setStatus("#stream-status", "Active · page-owned canvas capture track");
  }));

  switchButton.addEventListener("click", () => guardedTask("Switch source", async () => {
    if (pendingSwitch === null) throw new Error("Choose a second local source first.");
    const previousTrackId = session.hasPipeline ? session.getTrack().id : null;
    const stream = await session.switchSource(pendingSwitch);
    if (stream !== null) await attachStream(stream);
    const nextTrackId = session.hasPipeline ? session.getTrack().id : null;
    setStatus("#stream-status", "Source switched · capture track retained");
    recordLog("Source-switch identity check.", { previousTrackId, nextTrackId, retainedTrack: previousTrackId === nextTrackId });
    pendingSwitch = null;
    switchButton.disabled = true;
    switchInput.value = "";
  }));

  pauseButton.addEventListener("click", () => guardedTask("Pause source", async () => {
    await session.pauseSource();
    displayTrack("#track-info", session.getStream());
  }));
  resumeButton.addEventListener("click", () => guardedTask("Resume source", async () => {
    await session.resumeSource();
    displayTrack("#track-info", session.getStream());
  }));
  stopButton.addEventListener("click", () => guardedTask("Stop stream", async () => {
    await session.stop();
    probeButton.disabled = true;
    displayTrack("#track-info", session.getStream());
    setStatus("#stream-status", "Stopped · track ended; source remains loaded");
  }));
  restartButton.addEventListener("click", () => guardedTask("Restart stream", async () => {
    const stream = await session.restart();
    await attachStream(stream);
    probeButton.disabled = !receiverReady;
    setStatus("#stream-status", "Active · restarted with a new track");
  }));
  disposeButton.addEventListener("click", () => guardedTask("Dispose stream", async () => {
    await session.disposeStream();
    preview.pause();
    preview.srcObject = null;
    displayTrack("#track-info", null);
    createButton.disabled = !session.hasSource;
    switchInput.disabled = true;
    switchButton.disabled = true;
    pauseButton.disabled = true;
    resumeButton.disabled = true;
    stopButton.disabled = true;
    restartButton.disabled = true;
    disposeButton.disabled = true;
    probeButton.disabled = true;
    setStatus("#stream-status", "Disposed · local source remains loaded");
  }));

  probeButton.addEventListener("click", () => {
    if (!session.hasPipeline) {
      recordLog("Create a stream before running the page-to-page structured-clone probe.");
      return;
    }
    const target = iframe.contentWindow;
    if (target === null || !receiverReady) {
      recordLog("The same-origin receiver iframe is not ready.");
      return;
    }
    pendingProbeId = crypto.randomUUID();
    probeButton.disabled = true;
    if (probeTimer !== null) window.clearTimeout(probeTimer);
    probeTimer = window.setTimeout(() => {
      if (pendingProbeId === null) return;
      recordLog("No iframe acknowledgement arrived. Check for a messageerror or receiver-side serialization failure.", { probeId: pendingProbeId });
      pendingProbeId = null;
      probeButton.disabled = false;
    }, 8_000);
    try {
      target.postMessage({ type: TRANSFER_MESSAGE, probeId: pendingProbeId, stream: session.getStream() }, window.location.origin);
      recordLog("Posted the live MediaStream through native window.postMessage to a same-origin iframe.", {
        probeId: pendingProbeId,
        sourceStreamId: session.getStream().id,
        sourceTracks: session.getStream().getTracks().map(trackSnapshot),
      });
    } catch (error) {
      if (probeTimer !== null) window.clearTimeout(probeTimer);
      probeTimer = null;
      pendingProbeId = null;
      probeButton.disabled = false;
      recordLog("window.postMessage threw while cloning the MediaStream.", { error: errorText(error) });
      setStatus("#stream-status", "postMessage clone failed");
    }
  });

  window.addEventListener("message", (event: MessageEvent<unknown>) => {
    if (event.origin !== window.location.origin || event.source !== iframe.contentWindow || !plainObject(event.data)) return;
    if (event.data.type === RECEIVER_READY_MESSAGE) {
      receiverReady = true;
      probeButton.disabled = !session.hasPipeline;
      recordLog("Same-origin iframe receiver is ready in its own page JavaScript context.");
      return;
    }
    if (event.data.type !== TRANSFER_RESULT_MESSAGE || event.data.probeId !== pendingProbeId) return;
    if (probeTimer !== null) window.clearTimeout(probeTimer);
    probeTimer = null;
    pendingProbeId = null;
    probeButton.disabled = !session.hasPipeline;
    const result = event.data.result;
    const passed = plainObject(result) && result.accepted === true && result.displayStarted === true &&
      typeof result.trackCount === "number" && result.trackCount > 0;
    recordLog(passed ? "The iframe received a MediaStream and started displaying its track." : "The iframe did not confirm a displayable MediaStream track.", result);
    setStatus("#stream-status", passed ? "Same-origin page-to-page probe passed" : "Same-origin page-to-page probe failed");
  });

  window.addEventListener("messageerror", () => {
    recordLog("The browser fired messageerror while deserializing the iframe message.");
    setStatus("#stream-status", "postMessage deserialization error");
    pendingProbeId = null;
    if (probeTimer !== null) window.clearTimeout(probeTimer);
    probeTimer = null;
    probeButton.disabled = !session.hasPipeline;
  });

  window.addEventListener("pagehide", () => {
    if (probeTimer !== null) window.clearTimeout(probeTimer);
    void session.cleanup();
    stopTracks(preview.srcObject instanceof MediaStream ? preview.srcObject : null);
  });
}

interface LoopbackSession {
  senderPeer: RTCPeerConnection;
  receiverPeer: RTCPeerConnection;
  senders: RTCRtpSender[];
  close(): void;
}

async function waitForIceGathering(peer: RTCPeerConnection): Promise<void> {
  if (peer.iceGatheringState === "complete") return;
  await new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => finish(new Error("Timed out gathering local ICE candidates.")), 10_000);
    const onStateChange = (): void => {
      if (peer.iceGatheringState === "complete") finish();
    };
    const finish = (error?: Error): void => {
      window.clearTimeout(timer);
      peer.removeEventListener("icegatheringstatechange", onStateChange);
      if (error === undefined) resolve();
      else reject(error);
    };
    peer.addEventListener("icegatheringstatechange", onStateChange);
  });
}

async function waitForConnection(sender: RTCPeerConnection, receiver: RTCPeerConnection): Promise<void> {
  const bothConnected = (): boolean => sender.connectionState === "connected" && receiver.connectionState === "connected";
  if (bothConnected()) return;
  await new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => finish(new Error("Timed out waiting for the local WebRTC peers to connect.")), 15_000);
    const onChange = (): void => {
      if (bothConnected()) finish();
      else if (sender.connectionState === "failed" || receiver.connectionState === "failed") {
        finish(new Error(`Local peer connection failed: sender=${sender.connectionState}, receiver=${receiver.connectionState}.`));
      }
    };
    const cleanup = (): void => {
      window.clearTimeout(timer);
      sender.removeEventListener("connectionstatechange", onChange);
      receiver.removeEventListener("connectionstatechange", onChange);
    };
    const finish = (error?: Error): void => {
      cleanup();
      if (error === undefined) resolve();
      else reject(error);
    };
    sender.addEventListener("connectionstatechange", onChange);
    receiver.addEventListener("connectionstatechange", onChange);
    onChange();
  });
}

async function createLoopback(
  stream: MediaStream,
  remoteVideo: HTMLVideoElement,
  log: LogFunction,
): Promise<LoopbackSession> {
  const senderPeer = new RTCPeerConnection({ iceServers: [] });
  const receiverPeer = new RTCPeerConnection({ iceServers: [] });
  const receivedStream = new MediaStream();
  remoteVideo.srcObject = receivedStream;
  receiverPeer.addEventListener("track", (event) => {
    if (!receivedStream.getTracks().some((track) => track.id === event.track.id)) receivedStream.addTrack(event.track);
    displayTrack("#remote-track-info", receivedStream);
    log("Receiving peer got a remote track in its page context.", trackSnapshot(event.track));
    void remoteVideo.play().catch((error: unknown) => log("Remote video play was rejected.", { error: errorText(error) }));
  });
  senderPeer.addEventListener("connectionstatechange", () => log("Sender peer state changed.", { state: senderPeer.connectionState }));
  receiverPeer.addEventListener("connectionstatechange", () => log("Receiver peer state changed.", { state: receiverPeer.connectionState }));

  const senders: RTCRtpSender[] = [];
  try {
    for (const track of stream.getTracks()) senders.push(senderPeer.addTrack(track, stream));
    if (senders.length === 0) throw new Error("The source stream has no tracks to add.");
    log("Added source tracks to the local RTCPeerConnection with addTrack().", {
      streamId: stream.id,
      senders: senders.map((sender) => sender.track === null ? null : trackSnapshot(sender.track)),
    });

    const offer = await senderPeer.createOffer();
    await senderPeer.setLocalDescription(offer);
    await waitForIceGathering(senderPeer);
    if (senderPeer.localDescription === null) throw new Error("The sender produced no local offer.");
    await receiverPeer.setRemoteDescription(senderPeer.localDescription);

    const answer = await receiverPeer.createAnswer();
    await receiverPeer.setLocalDescription(answer);
    await waitForIceGathering(receiverPeer);
    if (receiverPeer.localDescription === null) throw new Error("The receiver produced no local answer.");
    await senderPeer.setRemoteDescription(receiverPeer.localDescription);
    await waitForConnection(senderPeer, receiverPeer);

    log("Local offer/answer completed; no external signaling or ICE server was used.", {
      senderState: senderPeer.connectionState,
      receiverState: receiverPeer.connectionState,
    });
    return {
      senderPeer,
      receiverPeer,
      senders,
      close: () => {
        senderPeer.close();
        receiverPeer.close();
        remoteVideo.pause();
        remoteVideo.srcObject = null;
        stopTracks(receivedStream);
      },
    };
  } catch (error) {
    senderPeer.close();
    receiverPeer.close();
    remoteVideo.pause();
    remoteVideo.srcObject = null;
    stopTracks(receivedStream);
    throw error;
  }
}

function setupLoopback(): void {
  const sourceInput = element<HTMLInputElement>("#source-file");
  const startButton = element<HTMLButtonElement>("#start-loopback");
  const closeButton = element<HTMLButtonElement>("#close-loopback");
  const localPreview = element<HTMLVideoElement>("#local-preview");
  const remotePreview = element<HTMLVideoElement>("#remote-preview");
  const session = new PageGeneratedMediaSession(element<HTMLDivElement>("#canvas-mount"), recordLog);
  let loopback: LoopbackSession | null = null;

  sourceInput.addEventListener("change", () => {
    const file = sourceInput.files?.[0];
    if (file === undefined) return;
    guardedTask("Local source decode", async () => {
      const source = await session.addSource(file);
      setStatus("#stream-status", `Loaded · ${source.fileName} · ${source.source.width}×${source.source.height}`);
      startButton.disabled = false;
      recordLog("Decoded local source for a page-owned canvas capture pipeline.", { fileName: source.fileName, kind: source.source.kind });
    });
  });

  startButton.addEventListener("click", () => guardedTask("WebRTC addTrack loopback", async () => {
    if (loopback !== null) throw new Error("Close the existing peer connection before starting another.");
    const stream = session.hasPipeline ? session.getStream() : await session.start();
    localPreview.srcObject = stream;
    await localPreview.play();
    displayTrack("#track-info", stream);
    loopback = await createLoopback(stream, remotePreview, recordLog);
    startButton.disabled = true;
    closeButton.disabled = false;
    setStatus("#stream-status", "Connected · local addTrack consumer");
  }));

  closeButton.addEventListener("click", () => {
    loopback?.close();
    loopback = null;
    closeButton.disabled = true;
    startButton.disabled = !session.hasSource;
    setStatus("#stream-status", "Peers closed · generated stream still page-owned");
    recordLog("RTCPeerConnection objects closed. The generated capture stream remains independent.");
  });

  window.addEventListener("pagehide", () => {
    loopback?.close();
    void session.cleanup();
    stopTracks(localPreview.srcObject instanceof MediaStream ? localPreview.srcObject : null);
  });
}

function setupReplaceTrack(): void {
  const requestCameraButton = element<HTMLButtonElement>("#request-camera");
  const startCallButton = element<HTMLButtonElement>("#start-call");
  const sourceInput = element<HTMLInputElement>("#source-file");
  const startCapcamButton = element<HTMLButtonElement>("#start-capcam-stream");
  const replaceButton = element<HTMLButtonElement>("#replace-track");
  const restoreButton = element<HTMLButtonElement>("#restore-camera");
  const stopButton = element<HTMLButtonElement>("#stop-test");
  const cameraPreview = element<HTMLVideoElement>("#camera-preview");
  const capcamPreview = element<HTMLVideoElement>("#capcam-preview");
  const remotePreview = element<HTMLVideoElement>("#remote-preview");
  const session = new PageGeneratedMediaSession(null, recordLog);
  let cameraStream: MediaStream | null = null;
  let cameraTrack: MediaStreamTrack | null = null;
  let loopback: LoopbackSession | null = null;
  let cameraSender: RTCRtpSender | null = null;
  let cleanupStarted = false;

  requestCameraButton.addEventListener("click", () => guardedTask("Native getUserMedia", async () => {
    const nativeGetUserMedia = navigator.mediaDevices?.getUserMedia;
    if (typeof nativeGetUserMedia !== "function") throw new Error("getUserMedia is unavailable; use a secure origin such as localhost or an extension page.");
    if (cameraStream !== null) throw new Error("Stop and clean up the current camera stream first.");
    recordLog("Calling the unmodified native getUserMedia({ audio: false, video: true }) for the initial sender track.");
    cameraStream = await nativeGetUserMedia.call(navigator.mediaDevices, { audio: false, video: true });
    cameraTrack = cameraStream.getVideoTracks()[0] ?? null;
    if (cameraTrack === null) throw new Error("The browser returned no native video track.");
    cameraPreview.srcObject = cameraStream;
    await cameraPreview.play();
    displayTrack("#camera-track-info", cameraStream);
    requestCameraButton.disabled = true;
    startCallButton.disabled = false;
    setStatus("#stream-status", `Native camera active · ${cameraTrack.readyState}`);
    recordLog("Native camera stream is now visible on the page; no getUserMedia shim is installed.", trackSnapshot(cameraTrack));
  }));

  startCallButton.addEventListener("click", () => guardedTask("Native camera WebRTC setup", async () => {
    if (cameraStream === null) throw new Error("Request the native camera first.");
    loopback = await createLoopback(cameraStream, remotePreview, recordLog);
    cameraSender = loopback.senders.find((sender) => sender.track?.kind === "video") ?? null;
    if (cameraSender === null) throw new Error("The local call did not create a video sender.");
    startCallButton.disabled = true;
    setStatus("#stream-status", "Connected · sender uses native camera track");
    element<HTMLElement>("#sender-info").textContent = JSON.stringify({
      initialSenderTrack: cameraSender.track === null ? null : trackSnapshot(cameraSender.track),
      connectionState: loopback.senderPeer.connectionState,
    }, null, 2);
    recordLog("Local WebRTC sender is transmitting the original native camera track.", trackSnapshot(cameraSender.track as MediaStreamTrack));
  }));

  sourceInput.addEventListener("change", () => {
    const file = sourceInput.files?.[0];
    if (file === undefined) return;
    guardedTask("CapCam local source decode", async () => {
      const source = await session.addSource(file);
      setStatus("#stream-status", `CapCam source ready · ${source.fileName}`);
      startCapcamButton.disabled = false;
      recordLog("Local replacement source decoded in this page; not acquired from a camera device.", {
        fileName: source.fileName,
        kind: source.source.kind,
        width: source.source.width,
        height: source.source.height,
      });
    });
  });

  startCapcamButton.addEventListener("click", () => guardedTask("CapCam stream creation", async () => {
    const stream = await session.start();
    capcamPreview.srcObject = stream;
    await capcamPreview.play();
    displayTrack("#track-info", stream);
    startCapcamButton.disabled = true;
    replaceButton.disabled = cameraSender === null;
    setStatus("#stream-status", "Both tracks available · call still uses native camera");
  }));

  replaceButton.addEventListener("click", () => guardedTask("RTCRtpSender.replaceTrack", async () => {
    if (cameraSender === null) throw new Error("Start the native-camera WebRTC call first.");
    const previousTrack = cameraSender.track;
    const nextTrack = session.getTrack();
    if (previousTrack?.kind !== "video" || nextTrack.kind !== "video") throw new Error("replaceTrack requires the existing video sender and a video replacement track.");
    await cameraSender.replaceTrack(nextTrack);
    const senderState = {
      previousTrack: trackSnapshot(previousTrack),
      requestedReplacement: trackSnapshot(nextTrack),
      senderNowUses: cameraSender.track === null ? null : trackSnapshot(cameraSender.track),
      senderTrackMatchesCapCam: cameraSender.track?.id === nextTrack.id,
      signalingState: loopback?.senderPeer.signalingState ?? "no peer",
      connectionState: loopback?.senderPeer.connectionState ?? "no peer",
    };
    element<HTMLElement>("#sender-info").textContent = JSON.stringify(senderState, null, 2);
    restoreButton.disabled = cameraTrack?.readyState !== "live";
    replaceButton.disabled = true;
    setStatus("#stream-status", "replaceTrack resolved · inspect remote received video");
    recordLog("RTCRtpSender.replaceTrack(CapCam videoTrack) resolved; remote rendering still requires visual verification.", senderState);
  }));

  restoreButton.addEventListener("click", () => guardedTask("Restore native sender track", async () => {
    if (cameraSender === null || cameraTrack === null || cameraTrack.readyState !== "live") throw new Error("The original native camera track is no longer live.");
    const previousTrack = cameraSender.track;
    await cameraSender.replaceTrack(cameraTrack);
    const state = {
      previousTrack: previousTrack === null ? null : trackSnapshot(previousTrack),
      senderNowUses: cameraSender.track === null ? null : trackSnapshot(cameraSender.track),
    };
    element<HTMLElement>("#sender-info").textContent = JSON.stringify(state, null, 2);
    replaceButton.disabled = !session.hasPipeline;
    restoreButton.disabled = true;
    recordLog("Sender was explicitly restored to the still-live native camera track.", state);
  }));

  const cleanup = async (): Promise<void> => {
    if (cleanupStarted) return;
    cleanupStarted = true;
    loopback?.close();
    loopback = null;
    cameraSender = null;
    await session.cleanup();
    stopTracks(cameraStream);
    cameraStream = null;
    cameraTrack = null;
    cameraPreview.pause();
    cameraPreview.srcObject = null;
    capcamPreview.pause();
    capcamPreview.srcObject = null;
    remotePreview.pause();
    remotePreview.srcObject = null;
    displayTrack("#camera-track-info", null);
    displayTrack("#track-info", null);
    element<HTMLElement>("#sender-info").textContent = "No sender.";
    requestCameraButton.disabled = false;
    startCallButton.disabled = true;
    startCapcamButton.disabled = true;
    replaceButton.disabled = true;
    restoreButton.disabled = true;
    setStatus("#stream-status", "Stopped · camera, peers, canvas track, and source URLs released");
    recordLog("Cleanup completed: peers closed, camera and generated tracks stopped, sources released.");
    cleanupStarted = false;
  };

  stopButton.addEventListener("click", () => guardedTask("Cleanup", cleanup));
  window.addEventListener("pagehide", () => { void cleanup(); });
}

function setupOffscreenBridge(): void {
  const fileInput = element<HTMLInputElement>("#offscreen-file");
  const ingestButton = element<HTMLButtonElement>("#ingest-file");
  const createButton = element<HTMLButtonElement>("#create-stream");
  const startButton = element<HTMLButtonElement>("#start-stream");
  const restartButton = element<HTMLButtonElement>("#restart-stream");
  const switchSourceButton = element<HTMLButtonElement>("#switch-stream-source");
  const stopButton = element<HTMLButtonElement>("#stop-stream");
  const disposeButton = element<HTMLButtonElement>("#dispose-stream");
  const refreshButton = element<HTMLButtonElement>("#refresh-state");
  const sourceSelect = element<HTMLSelectElement>("#source-select");
  const openConsumerButton = element<HTMLButtonElement>("#open-consumer");
  const requestStreamButton = element<HTMLButtonElement>("#request-offscreen-stream");
  const playbackPlayButton = element<HTMLButtonElement>("#playback-play");
  const playbackPauseButton = element<HTMLButtonElement>("#playback-pause");
  const preview = element<HTMLVideoElement>("#extension-preview");
  const stateOutput = element<HTMLElement>("#offscreen-state");
  const verificationOverall = element<HTMLElement>("#phase06-evidence-overall");
  const verificationOutput = element<HTMLElement>("#phase06-evidence-report");
  const downloadEvidenceButton = element<HTMLButtonElement>("#download-phase06-evidence");
  const cameraTestBuild = import.meta.env.MODE === "camera-test";
  const createdAt = new Date().toISOString();
  const checkIds: Phase06CheckId[] = [
    "playback", "mediaStreamCreation", "videoTrackCreation", "offscreenCommunication", "consumerConnection",
    "frameReception", "trackLifecycle", "cleanup",
  ];
  const evidenceReport = {
    schemaVersion: 1,
    runId: crypto.randomUUID(),
    createdAt,
    updatedAt: createdAt,
    source: "Live browser page observations only; automated tests/builds never set these verdicts.",
    environment: {
      browserUserAgent: navigator.userAgent,
      extensionOrigin: window.location.origin,
      controlledConsumerUrl: PHASE06_LOCAL_CONSUMER_URL,
      buildMode: import.meta.env.MODE,
      cameraTestBuild,
    },
    pathReportStatus: "UNVERIFIED" as VerificationVerdict,
    checks: Object.fromEntries(checkIds.map((id) => [id, {
      status: "UNVERIFIED" as VerificationVerdict,
      updatedAt: null,
      observation: "No live browser observation recorded.",
      evidence: null,
    }])) as Record<Phase06CheckId, Phase06Check>,
    diagnostics: { events: [] as Phase06DiagnosticEvent[] },
  };
  const renderEvidenceReport = (): void => {
    verificationOutput.textContent = JSON.stringify(evidenceReport, null, 2);
    verificationOverall.textContent = `Path report: ${evidenceReport.pathReportStatus}`;
    verificationOverall.dataset.verdict = evidenceReport.pathReportStatus;
  };
  const recordDiagnosticEvent = (
    type: Phase06DiagnosticEvent["type"],
    requestId: string | null,
    evidence: Record<string, unknown>,
  ): void => {
    evidenceReport.diagnostics.events.push({ type, observedAt: new Date().toISOString(), requestId, evidence });
    if (evidenceReport.diagnostics.events.length > 100) evidenceReport.diagnostics.events.shift();
    evidenceReport.updatedAt = new Date().toISOString();
    renderEvidenceReport();
  };
  const updateEvidenceCheck = (
    id: Phase06CheckId,
    status: VerificationVerdict,
    observation: string,
    evidence: Record<string, unknown> | null = null,
  ): void => {
    evidenceReport.checks[id] = {
      status,
      updatedAt: new Date().toISOString(),
      observation: observation.slice(0, 400),
      evidence,
    };
    const statuses = Object.values(evidenceReport.checks).map((check) => check.status);
    evidenceReport.pathReportStatus = statuses.includes("FAIL") ? "FAIL" :
      statuses.includes("BLOCKED") ? "BLOCKED" :
        statuses.includes("UNVERIFIED") ? "UNVERIFIED" : "PASS";
    evidenceReport.updatedAt = new Date().toISOString();
    renderEvidenceReport();
  };
  renderEvidenceReport();
  downloadEvidenceButton.addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(evidenceReport, null, 2)], { type: "application/json" });
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = `phase06-chrome-evidence-${evidenceReport.runId}.json`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000);
  });
  const client = new MessagingClient();
  const ingestClient = new MediaIngestClient(client);
  let disposeInProgress = false;
  let channel: BroadcastChannel | null = null;
  let selectedFile: File | null = null;
  const mediaRecords = new Map<string, MediaRecord>();
  const consumerTransferRequestIds = new Set<string>();
  let mediaRecord: MediaRecord | null = null;
  let streamInfo: StreamInfo | null = null;
  let playbackInfo: PlaybackRecord | null = null;
  let receivedStream: MediaStream | null = null;
  let consumerWindow: Window | null = null;
  let consumerOrigin: string | null = null;
  let consumerReady = false;
  let pendingBridgeRequestId: string | null = null;
  let pendingExtensionFrameSampleId: string | null = null;
  let pendingWebRequestId: string | null = null;
  let pendingConsumerDisposeId: string | null = null;
  let pendingConsumerInspectId: string | null = null;
  let bridgeTimer: number | null = null;
  let consumerReadyTimer: number | null = null;
  let consumerReceiptTimer: number | null = null;
  let consumerDisposeTimer: number | null = null;
  let consumerInspectTimer: number | null = null;
  let resolveConsumerDispose: ((message: LocalConsumerDisposedMessage | null) => void) | null = null;
  let resolveConsumerInspect: ((message: LocalConsumerInspectedMessage | null) => void) | null = null;
  let extensionFrameEvidence: LocalConsumerFrameEvidence | null = null;
  let consumerFrameEvidence: LocalConsumerFrameEvidence | null = null;
  let initialTrackId: string | null = null;
  let lastConsumerTrackId: string | null = null;
  let lifecycleStopObservation: {
    previousStreamId: string | null;
    previousSourceTrackId: string | null;
    previousConsumerTrackId: string | null;
    sourceTrackState: string | null;
    extensionTrackState: string | null;
    consumerStreamPresent: boolean;
    consumerTrackStates: string[];
  } | null = null;
  let lifecycleRestartObservation: {
    previousTrackId: string | null;
    nextTrackId: string | null;
    sourceTrackState: string | null;
    sourceTrackChanged: boolean;
  } | null = null;

  const updateSourceOptions = (): void => {
    sourceSelect.replaceChildren();
    if (mediaRecords.size === 0) {
      const emptyOption = document.createElement("option");
      emptyOption.value = "";
      emptyOption.textContent = "No sources loaded";
      sourceSelect.append(emptyOption);
      return;
    }
    for (const record of mediaRecords.values()) {
      const option = document.createElement("option");
      option.value = record.id;
      option.textContent = `${record.name} · ${record.kind} · ${record.status}`;
      sourceSelect.append(option);
    }
    sourceSelect.value = mediaRecord?.id ?? "";
  };

  const updatePlaybackEvidence = (expectPlaying = false): void => {
    if (playbackInfo === null) {
      updateEvidenceCheck("playback", "UNVERIFIED", "No PlaybackEngine record has been observed yet.");
      return;
    }
    const selectedMediaMatches = mediaRecord === null || mediaRecord.id === playbackInfo.mediaId;
    if (!selectedMediaMatches) {
      updateEvidenceCheck("playback", "FAIL", "PlaybackEngine reports a different media ID than the selected source.", {
        playbackId: playbackInfo.playbackId,
        playbackMediaId: playbackInfo.mediaId,
        selectedMediaId: mediaRecord?.id ?? null,
        state: playbackInfo.state,
      });
      return;
    }
    const isPlaying = playbackInfo.state === "PLAYING";
    const failed = playbackInfo.state === "ERROR" || (expectPlaying && !isPlaying);
    updateEvidenceCheck("playback", failed ? "FAIL" : isPlaying ? "PASS" : "UNVERIFIED",
      isPlaying ? "The offscreen PlaybackEngine reports PLAYING for the selected local source."
        : `PlaybackEngine reports ${playbackInfo.state}; click Play loaded source to verify active playback.`,
      { ...playbackInfo, expectPlaying });
  };

  const updateFrameReceptionEvidence = (requestId: string): void => {
    const evidence = {
      requestId,
      extensionPage: extensionFrameEvidence,
      localConsumerPage: consumerFrameEvidence,
    };
    if (extensionFrameEvidence === null) {
      updateEvidenceCheck("frameReception", "UNVERIFIED", "Waiting for an extension-page frame sample.", evidence);
      return;
    }
    if (!extensionFrameEvidence.frameCallbackSupported) {
      updateEvidenceCheck("frameReception", "UNVERIFIED", "This browser did not expose requestVideoFrameCallback on the extension preview.", evidence);
      return;
    }
    if (extensionFrameEvidence.frameCount === 0) {
      updateEvidenceCheck("frameReception", "FAIL", "No presented frame was observed in the extension-page preview sample.", evidence);
      return;
    }
    if (consumerFrameEvidence === null) {
      updateEvidenceCheck("frameReception", "UNVERIFIED", "Extension-page frames were observed; waiting for the real localhost consumer frame sample.", evidence);
      return;
    }
    if (!consumerFrameEvidence.frameCallbackSupported) {
      updateEvidenceCheck("frameReception", "UNVERIFIED", "The localhost consumer cannot report presented frames because requestVideoFrameCallback is unavailable.", evidence);
      return;
    }
    if (consumerFrameEvidence.frameCount === 0) {
      updateEvidenceCheck("frameReception", "FAIL", "The localhost consumer received a stream but observed no presented video frames.", evidence);
      return;
    }
    if (consumerFrameEvidence.trackReadyState !== "live" || consumerFrameEvidence.videoWidth <= 0 || consumerFrameEvidence.videoHeight <= 0) {
      updateEvidenceCheck("frameReception", "FAIL", "The localhost consumer frame callback did not coincide with a live, dimensioned video track.", evidence);
      return;
    }
    updateEvidenceCheck("frameReception", "PASS", "requestVideoFrameCallback observed presented frames in both extension and localhost consumer pages.", evidence);
  };

  const renderState = (): void => {
    stateOutput.textContent = JSON.stringify({
      selectedMedia: mediaRecord === null ? null : { id: mediaRecord.id, name: mediaRecord.name, kind: mediaRecord.kind, status: mediaRecord.status },
      sources: [...mediaRecords.values()].map(({ id, name, kind, status }) => ({ id, name, kind, status })),
      playback: playbackInfo,
      stream: streamInfo,
    }, null, 2);
    const hasStream = streamInfo?.streamId !== null && streamInfo?.streamId !== undefined && !streamInfo.disposed;
    const canSwitch = hasStream && mediaRecord !== null && mediaRecord.id !== streamInfo?.sourceMediaId &&
      ["READY", "ACTIVE", "STOPPED", "ERROR"].includes(streamInfo?.state ?? "");
    createButton.disabled = mediaRecord === null || hasStream;
    sourceSelect.disabled = mediaRecords.size === 0;
    startButton.disabled = !hasStream || streamInfo?.state !== "READY" || playbackInfo?.state !== "PLAYING";
    restartButton.disabled = !hasStream || streamInfo?.state === "ACTIVE";
    switchSourceButton.disabled = !canSwitch;
    stopButton.disabled = !hasStream || streamInfo?.state !== "ACTIVE";
    disposeButton.disabled = disposeInProgress || (!hasStream && mediaRecords.size === 0);
    playbackPlayButton.disabled = playbackInfo === null || playbackInfo.state === "PLAYING" || playbackInfo.state === "LOADING" || playbackInfo.state === "ERROR";
    playbackPauseButton.disabled = playbackInfo?.state !== "PLAYING";
    requestStreamButton.disabled = !cameraTestBuild || channel === null || !consumerReady || streamInfo?.state !== "ACTIVE" ||
      pendingBridgeRequestId !== null || pendingExtensionFrameSampleId !== null || pendingWebRequestId !== null;
  };

  const refreshState = async (): Promise<void> => {
    [streamInfo, playbackInfo] = await Promise.all([
      client.send("stream.getState"),
      client.send("playback.getState"),
    ]);
    renderState();
    updatePlaybackEvidence();
    setStatus("#stream-status", streamInfo.streamId === null ? "No offscreen stream" : `Offscreen stream · ${streamInfo.state}`);
  };

  const postReceivedStreamToConsumer = (): void => {
    if (receivedStream === null || consumerWindow === null || consumerOrigin === null || !consumerReady || pendingWebRequestId !== null) return;
    const sourceTracks = receivedStream.getTracks();
    const sourceVideoTracks = receivedStream.getVideoTracks();
    if (sourceVideoTracks.length !== 1 || receivedStream.getAudioTracks().length !== 0 || sourceVideoTracks[0]?.readyState !== "live") {
      setStatus("#consumer-status", "INTEGRATION_ERROR · refusing to forward a non-live video-only stream");
      recordLog("Refused to post an invalid or ended offscreen track to the localhost page.", { tracks: sourceTracks.map(trackSnapshot) });
      updateEvidenceCheck("consumerConnection", "FAIL", "The extension page refused to forward a non-live or non-video-only stream.", { tracks: sourceTracks.map(trackSnapshot) });
      return;
    }
    if (consumerWindow.closed) {
      consumerWindow = null;
      consumerOrigin = null;
      consumerReady = false;
      setStatus("#consumer-status", "Consumer tab closed");
      updateEvidenceCheck("consumerConnection", "BLOCKED", "The controlled localhost consumer tab closed before stream receipt.");
      renderState();
      return;
    }
    const requestId = crypto.randomUUID();
    consumerTransferRequestIds.add(requestId);
    if (consumerTransferRequestIds.size > 100) consumerTransferRequestIds.delete(consumerTransferRequestIds.values().next().value as string);
    pendingWebRequestId = requestId;
    renderState();
    consumerReceiptTimer = window.setTimeout(() => {
      if (pendingWebRequestId !== requestId) return;
      pendingWebRequestId = null;
      consumerReceiptTimer = null;
      updateEvidenceCheck("consumerConnection", "FAIL", "No bounded stream-receipt acknowledgement arrived from the localhost consumer.", { requestId, timeoutMs: CONSUMER_RECEIPT_TIMEOUT_MS, targetOrigin: consumerOrigin });
      updateEvidenceCheck("frameReception", "FAIL", "The localhost consumer did not acknowledge receipt, so no consumer-side frame evidence was reported.", { requestId });
      setStatus("#consumer-status", "Timed out waiting for consumer stream receipt");
      recordLog("The localhost consumer did not acknowledge stream receipt before the bounded timeout.", { requestId, timeoutMs: CONSUMER_RECEIPT_TIMEOUT_MS });
      renderState();
    }, CONSUMER_RECEIPT_TIMEOUT_MS);
    try {
      consumerWindow.postMessage({
        protocol: LOCAL_CONSUMER_PROTOCOL_VERSION,
        type: "capcam.local-consumer.stream",
        requestId,
        stream: receivedStream,
      }, consumerOrigin);
      setStatus("#consumer-status", "Sent actual offscreen stream to localhost page · awaiting receipt");
      recordLog("Posted the received offscreen MediaStream from this extension page to the localhost consumer with an exact target origin.", {
        requestId,
        targetOrigin: consumerOrigin,
        streamId: receivedStream.id,
        tracks: receivedStream.getTracks().map(trackSnapshot),
      });
    } catch (error) {
      pendingWebRequestId = null;
      if (consumerReceiptTimer !== null) window.clearTimeout(consumerReceiptTimer);
      consumerReceiptTimer = null;
      setStatus("#consumer-status", "window.postMessage cloning failed");
      recordLog("Cross-origin window.postMessage threw while cloning the active offscreen MediaStream.", { error: errorText(error) });
      updateEvidenceCheck("consumerConnection", "FAIL", "window.postMessage threw while cloning the active MediaStream.", { requestId, error: errorText(error) });
      updateEvidenceCheck("frameReception", "FAIL", "The stream could not be delivered to the localhost consumer, so no consumer frame observation exists.", { requestId });
      renderState();
    }
  };

  const finishConsumerDispose = (requestId: string, message: LocalConsumerDisposedMessage | null): void => {
    if (pendingConsumerDisposeId !== requestId) return;
    if (consumerDisposeTimer !== null) window.clearTimeout(consumerDisposeTimer);
    consumerDisposeTimer = null;
    pendingConsumerDisposeId = null;
    const resolve = resolveConsumerDispose;
    resolveConsumerDispose = null;
    resolve?.(message);
  };

  const requestConsumerDispose = (): Promise<LocalConsumerDisposedMessage | null> => {
    const targetWindow = consumerWindow;
    const targetOrigin = consumerOrigin;
    if (targetWindow === null || targetOrigin === null || !consumerReady || targetWindow.closed) {
      return Promise.resolve(null);
    }
    if (pendingConsumerDisposeId !== null) return Promise.resolve(null);
    const requestId = crypto.randomUUID();
    pendingConsumerDisposeId = requestId;
    return new Promise((resolve) => {
      resolveConsumerDispose = resolve;
      consumerDisposeTimer = window.setTimeout(() => {
        if (pendingConsumerDisposeId !== requestId) return;
        recordLog("The localhost consumer did not acknowledge cleanup before the bounded timeout; extension-owned cleanup will continue.", { requestId });
        finishConsumerDispose(requestId, null);
      }, 2_500);
      try {
        targetWindow.postMessage({
          protocol: LOCAL_CONSUMER_PROTOCOL_VERSION,
          type: "capcam.local-consumer.dispose",
          requestId,
        }, targetOrigin);
        recordLog("Requested bounded cleanup from the exact-origin localhost consumer before disposing the offscreen stream.", { requestId });
      } catch (error) {
        recordLog("Could not post the cleanup request to the localhost consumer; extension-owned cleanup will continue.", {
          requestId,
          error: errorText(error),
        });
        finishConsumerDispose(requestId, null);
      }
    });
  };

  const finishConsumerInspect = (requestId: string, message: LocalConsumerInspectedMessage | null): void => {
    if (pendingConsumerInspectId !== requestId) return;
    if (consumerInspectTimer !== null) window.clearTimeout(consumerInspectTimer);
    consumerInspectTimer = null;
    pendingConsumerInspectId = null;
    const resolve = resolveConsumerInspect;
    resolveConsumerInspect = null;
    resolve?.(message);
  };

  const requestConsumerInspect = (): Promise<LocalConsumerInspectedMessage | null> => {
    const targetWindow = consumerWindow;
    const targetOrigin = consumerOrigin;
    if (targetWindow === null || targetOrigin === null || !consumerReady || targetWindow.closed || pendingConsumerInspectId !== null) {
      return Promise.resolve(null);
    }
    const requestId = crypto.randomUUID();
    pendingConsumerInspectId = requestId;
    return new Promise((resolve) => {
      resolveConsumerInspect = resolve;
      consumerInspectTimer = window.setTimeout(() => finishConsumerInspect(requestId, null), CONSUMER_INSPECT_TIMEOUT_MS);
      try {
        targetWindow.postMessage({
          protocol: LOCAL_CONSUMER_PROTOCOL_VERSION,
          type: "capcam.local-consumer.inspect",
          requestId,
        }, targetOrigin);
      } catch (error) {
        recordLog("Could not post the consumer track-inspection request.", { requestId, error: errorText(error) });
        finishConsumerInspect(requestId, null);
      }
    });
  };

  if (typeof chrome === "undefined" || chrome.runtime?.id === undefined) {
    setStatus("#stream-status", "Open this page from the loaded camera-test extension build");
    recordLog("Chrome extension runtime is unavailable. This page can only access the real offscreen document when opened from the camera-test build.");
  } else {
    try {
      channel = new BroadcastChannel(OFFSCREEN_STREAM_BRIDGE_CHANNEL);
      channel.addEventListener("message", (event: MessageEvent<unknown>) => {
        if (!isOffscreenStreamBridgeResponse(event.data) || event.data.requestId !== pendingBridgeRequestId) return;
        if (bridgeTimer !== null) window.clearTimeout(bridgeTimer);
        bridgeTimer = null;
        pendingBridgeRequestId = null;
        const responseRequestId = event.data.requestId;
        updateEvidenceCheck("offscreenCommunication", "PASS", "Received a versioned BroadcastChannel response correlated to the request UUID.", {
          requestId: event.data.requestId,
          responseType: event.data.type,
          channel: OFFSCREEN_STREAM_BRIDGE_CHANNEL,
        });
        renderState();
        if (event.data.type === "error") {
          setStatus("#stream-status", "Offscreen bridge returned an error");
          recordLog("Offscreen test bridge could not provide an active stream.", { message: event.data.message });
          updateEvidenceCheck("mediaStreamCreation", "FAIL", "The offscreen bridge returned an error instead of an active MediaStream.", { requestId: event.data.requestId, message: event.data.message });
          updateEvidenceCheck("videoTrackCreation", "UNVERIFIED", "No MediaStream object was received to inspect for video tracks.", { requestId: event.data.requestId });
          requestStreamButton.disabled = false;
          renderState();
          return;
        }
        const stream = event.data.stream;
        if (!(stream instanceof MediaStream)) {
          setStatus("#stream-status", "Received value was not a MediaStream in this extension page");
          recordLog("BroadcastChannel response arrived, but the extension page did not receive a native MediaStream object.");
          updateEvidenceCheck("mediaStreamCreation", "FAIL", "BroadcastChannel returned a value that is not a MediaStream in the extension page.", { requestId: event.data.requestId, receivedType: typeof stream });
          updateEvidenceCheck("videoTrackCreation", "UNVERIFIED", "No MediaStream object was available to inspect for a video track.");
          requestStreamButton.disabled = false;
          renderState();
          return;
        }
        const videoTracks = stream.getVideoTracks();
        const audioTracks = stream.getAudioTracks();
        updateEvidenceCheck("mediaStreamCreation", "PASS", "The extension page received a native MediaStream object from the offscreen BroadcastChannel response.", {
          requestId: event.data.requestId,
          streamId: stream.id,
          active: stream.active,
          totalTrackCount: stream.getTracks().length,
        });
        const inspectedTrack = videoTracks[0];
        const validVideoTrack = videoTracks.length === 1 && audioTracks.length === 0 && inspectedTrack?.readyState === "live";
        updateEvidenceCheck("videoTrackCreation", validVideoTrack ? "PASS" : "FAIL",
          validVideoTrack ? "Received exactly one live video track and no audio tracks." : "Expected exactly one live video track and no audio tracks.",
          { streamId: stream.id, videoTrackCount: videoTracks.length, audioTrackCount: audioTracks.length,
            track: inspectedTrack === undefined ? null : trackSnapshot(inspectedTrack) });
        if (!validVideoTrack || inspectedTrack === undefined) {
          stopTracks(stream);
          setStatus("#stream-status", "INTEGRATION_ERROR · expected one live video-only track");
          recordLog("The extension page rejected a malformed or already-ended offscreen stream before forwarding it.", {
            tracks: stream.getTracks().map(trackSnapshot),
          });
          requestStreamButton.disabled = false;
          renderState();
          return;
        }
        if (initialTrackId === null) initialTrackId = inspectedTrack.id;
        pendingExtensionFrameSampleId = event.data.requestId;
        requestStreamButton.disabled = true;
        stopTracks(receivedStream);
        receivedStream = stream;
        preview.srcObject = stream;
        displayTrack("#track-info", stream);
        extensionFrameEvidence = null;
        consumerFrameEvidence = null;
        void preview.play().then(async () => {
          setStatus("#stream-status", "Stream attached · sampling actual presented video frames");
          recordLog("The extension test page attached the offscreen stream; successful play() is not counted as frame evidence.", {
            streamId: stream.id,
            tracks: stream.getTracks().map(trackSnapshot),
          });
          extensionFrameEvidence = await samplePresentedFrames(preview);
          const extensionHasFrames = extensionFrameEvidence.frameCallbackSupported && extensionFrameEvidence.frameCount > 0;
          if (!extensionFrameEvidence.frameCallbackSupported) {
            updateEvidenceCheck("frameReception", "UNVERIFIED", "requestVideoFrameCallback is unavailable on the extension preview.", {
              requestId: responseRequestId, extensionPage: extensionFrameEvidence, localConsumerPage: null,
            });
          } else if (!extensionHasFrames) {
            updateEvidenceCheck("frameReception", "FAIL", "No presented frame was observed in the extension-page preview sample.", {
              requestId: responseRequestId, extensionPage: extensionFrameEvidence, localConsumerPage: null,
            });
          } else {
            updateEvidenceCheck("frameReception", "UNVERIFIED", "Extension-page frame callbacks observed actual frames; waiting for the localhost consumer sample.", {
              requestId: responseRequestId, extensionPage: extensionFrameEvidence, localConsumerPage: null,
            });
          }
          setStatus("#stream-status", extensionHasFrames
            ? `Extension preview presented ${extensionFrameEvidence.frameCount} frames · forwarding to consumer`
            : "Extension preview attached · no presented frame observed yet");
          recordLog("Extension-page requestVideoFrameCallback sample completed; frame counts come from frame-presentation callbacks, not play() success.", {
            requestId: responseRequestId,
            streamId: stream.id,
            frameEvidence: extensionFrameEvidence,
          });
          pendingExtensionFrameSampleId = null;
          postReceivedStreamToConsumer();
          renderState();
        }).catch((error: unknown) => {
          pendingExtensionFrameSampleId = null;
          requestStreamButton.disabled = false;
          setStatus("#stream-status", "Received stream · preview rejected by browser");
          recordLog("The extension page received a MediaStream object but could not start its preview.", { error: errorText(error) });
          updateEvidenceCheck("frameReception", "FAIL", "The extension preview rejected playback; no presented frame evidence can be collected.", { requestId: responseRequestId, error: errorText(error) });
          updateEvidenceCheck("consumerConnection", "UNVERIFIED", "The extension preview did not start; consumer forwarding was not attempted.", { requestId: responseRequestId });
          renderState();
        });
      });
      channel.addEventListener("messageerror", () => {
        const requestId = pendingBridgeRequestId;
        pendingBridgeRequestId = null;
        if (bridgeTimer !== null) window.clearTimeout(bridgeTimer);
        bridgeTimer = null;
        setStatus("#stream-status", "BroadcastChannel deserialization error");
        recordLog("The extension page received a messageerror while deserializing the offscreen stream response.");
        if (requestId !== null) {
          updateEvidenceCheck("offscreenCommunication", "FAIL", "BroadcastChannel raised messageerror while deserializing the offscreen response.", { requestId, channel: OFFSCREEN_STREAM_BRIDGE_CHANNEL });
          updateEvidenceCheck("mediaStreamCreation", "UNVERIFIED", "The offscreen message could not be deserialized into an inspectable MediaStream.", { requestId });
        }
        requestStreamButton.disabled = false;
      });
      setStatus("#stream-status", cameraTestBuild ? "Camera-test extension context · waiting for offscreen stream" : "Normal build · run npm run build:camera-test for the bridge experiment");
      recordLog(cameraTestBuild
        ? "Connected to the test-build-only versioned BroadcastChannel. Chrome runtime commands remain typed and serializable."
        : "This is a normal extension build. The offscreen BroadcastChannel listener is omitted; use npm run build:camera-test to run the boundary probe.");
      requestStreamButton.disabled = true;
      void refreshState().catch((error: unknown) => {
        recordLog("Initial offscreen stream status query failed.", { error: errorText(error) });
      });
    } catch (error) {
      channel = null;
      setStatus("#stream-status", "BroadcastChannel unavailable");
      recordLog("Could not open the test-only BroadcastChannel.", { error: errorText(error) });
    }
  }

  fileInput.addEventListener("change", () => {
    selectedFile = fileInput.files?.[0] ?? null;
    ingestButton.disabled = selectedFile === null;
  });

  sourceSelect.addEventListener("change", () => {
    mediaRecord = mediaRecords.get(sourceSelect.value) ?? null;
    setStatus("#stream-status", mediaRecord === null ? "Select or ingest a source" : `Selected source · ${mediaRecord.name}`);
    renderState();
  });

  ingestButton.addEventListener("click", () => guardedTask("Offscreen media ingest", async () => {
    if (selectedFile === null) throw new Error("Choose a local file first.");
    setStatus("#stream-status", "Staging temporary local-file handoff…");
    const record = await ingestClient.ingest(selectedFile);
    mediaRecords.set(record.id, record);
    mediaRecord = record;
    selectedFile = null;
    fileInput.value = "";
    updateSourceOptions();
    setStatus("#stream-status", `Offscreen media ready · ${record.name}`);
    recordLog("MediaIngestClient staged the selected file in the existing temporary IndexedDB handoff, then sent only a transfer ID through the typed runtime protocol.", {
      id: record.id,
      name: record.name,
      kind: record.kind,
      bytes: record.size,
      status: record.status,
      loadedSourceCount: mediaRecords.size,
    });
    renderState();
    ingestButton.disabled = true;
  }));

  createButton.addEventListener("click", () => guardedTask("Offscreen stream create", async () => {
    if (mediaRecord === null) throw new Error("Ingest a local image or video first.");
    const config: RenderConfig = { ...DEFAULT_RENDER_CONFIG, width: 1280, height: 720, fps: 30 };
    streamInfo = await client.send("stream.create", { mediaId: mediaRecord.id, config });
    playbackInfo = await client.send("playback.getState");
    updatePlaybackEvidence();
    renderState();
    setStatus("#stream-status", `Created · ${streamInfo.state} · click Play source, then Start`);
    recordLog("Created the production offscreen-owned CanvasStreamPipeline; stream.create also loaded the source into the offscreen PlaybackEngine.", {
      stream: streamInfo,
      playback: playbackInfo,
    });
  }));

  playbackPlayButton.addEventListener("click", () => guardedTask("Offscreen playback play", async () => {
    try {
      const currentPlayback = await client.send("playback.getState");
      if (currentPlayback === null) throw new Error("Create a stream to load the selected source into PlaybackEngine first.");
      playbackInfo = await client.send("playback.play", { playbackId: currentPlayback.playbackId });
      updatePlaybackEvidence(true);
      renderState();
      recordLog("Issued the explicit user-activated PlaybackEngine play command and recorded the runtime result.", playbackInfo);
    } catch (error) {
      updateEvidenceCheck("playback", "FAIL", "The explicit PlaybackEngine play command failed.", { error: errorText(error) });
      throw error;
    }
  }));

  playbackPauseButton.addEventListener("click", () => guardedTask("Offscreen playback pause", async () => {
    if (playbackInfo === null) throw new Error("No PlaybackEngine source is loaded.");
    try {
      playbackInfo = await client.send("playback.pause", { playbackId: playbackInfo.playbackId });
      updatePlaybackEvidence();
      renderState();
      recordLog("Issued the explicit PlaybackEngine pause command; playback state is separate from stream-track state.", playbackInfo);
    } catch (error) {
      updateEvidenceCheck("playback", "FAIL", "The explicit PlaybackEngine pause command failed.", { error: errorText(error) });
      throw error;
    }
  }));

  switchSourceButton.addEventListener("click", () => guardedTask("Switch active offscreen source", async () => {
    if (mediaRecord === null || streamInfo?.streamId === null || streamInfo?.streamId === undefined) {
      throw new Error("Ingest a second local source and create an active stream first.");
    }
    const previous = streamInfo;
    streamInfo = await client.send("stream.switchSource", {
      streamId: streamInfo.streamId,
      mediaId: mediaRecord.id,
    });
    playbackInfo = await client.send("playback.getState");
    updatePlaybackEvidence();
    const trackRetained = previous.track?.id !== null && previous.track?.id !== undefined &&
      previous.track.id === streamInfo.track?.id;
    renderState();
    setStatus("#stream-status", `Source switched · ${mediaRecord.name} · existing canvas track ${trackRetained ? "retained" : "changed"}`);
    recordLog("Switched the existing offscreen renderer source without disposing/recreating the canvas capture pipeline.", {
      fromMediaId: previous.sourceMediaId,
      toMediaId: streamInfo.sourceMediaId,
      previousTrack: previous.track,
      currentTrack: streamInfo.track,
      sameTrackId: trackRetained,
      streamId: streamInfo.streamId,
    });
  }));

  startButton.addEventListener("click", () => guardedTask("Offscreen stream start", async () => {
    if (streamInfo?.streamId === null || streamInfo?.streamId === undefined) throw new Error("Create an offscreen stream first.");
    streamInfo = await client.send("stream.start", { streamId: streamInfo.streamId });
    renderState();
    setStatus("#stream-status", `Offscreen stream · ${streamInfo.state}`);
    recordLog("Started the offscreen pipeline; the extension page has not received a MediaStream yet.", streamInfo);
  }));

  restartButton.addEventListener("click", () => guardedTask("Offscreen stream restart", async () => {
    if (streamInfo?.streamId === null || streamInfo?.streamId === undefined) throw new Error("Create an offscreen stream first.");
    const previousTrackId = lifecycleStopObservation?.previousSourceTrackId ?? streamInfo.track?.id ?? null;
    streamInfo = await client.send("stream.restart", { streamId: streamInfo.streamId });
    const nextTrackId = streamInfo.track?.id ?? null;
    const sourceTrackState = streamInfo.track?.readyState ?? null;
    const sourceTrackChanged = previousTrackId !== null && nextTrackId !== null && previousTrackId !== nextTrackId;
    lifecycleRestartObservation = { previousTrackId, nextTrackId, sourceTrackState, sourceTrackChanged };
    if (lifecycleStopObservation === null) {
      updateEvidenceCheck("trackLifecycle", "UNVERIFIED", "A restart was observed without a preceding recorded Stop; repeat the stop/restart sequence for lifecycle evidence.", {
        restarted: lifecycleRestartObservation,
      });
    } else if (sourceTrackState !== "live" || !sourceTrackChanged) {
      updateEvidenceCheck("trackLifecycle", "FAIL", "Offscreen restart did not expose a distinct live source track.", {
        stopped: lifecycleStopObservation,
        restarted: lifecycleRestartObservation,
      });
    } else {
      updateEvidenceCheck("trackLifecycle", "UNVERIFIED", "A distinct live offscreen track was created; request it again to verify the new page-world track.", {
        stopped: lifecycleStopObservation,
        restarted: lifecycleRestartObservation,
      });
    }
    renderState();
    setStatus("#stream-status", `Offscreen stream restarted · ${streamInfo.state}`);
    recordLog("Restarted the offscreen capture stream; request its current live track again to test another clone cycle.", streamInfo);
  }));

  stopButton.addEventListener("click", () => guardedTask("Offscreen stream stop", async () => {
    if (streamInfo?.streamId === null || streamInfo?.streamId === undefined) throw new Error("Create an offscreen stream first.");
    const previousStreamId = streamInfo.streamId;
    const previousSourceTrackId = streamInfo.track?.id ?? initialTrackId;
    await client.send("stream.stop", { streamId: previousStreamId });
    let consumerInspection: LocalConsumerInspectedMessage | null = null;
    let extensionTrackState: string | null = null;
    let sourceTrackState: string | null = null;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (attempt > 0) await new Promise<void>((resolve) => window.setTimeout(resolve, 250));
      streamInfo = await client.send("stream.getState");
      extensionTrackState = receivedStream?.getVideoTracks()[0]?.readyState ?? null;
      sourceTrackState = streamInfo.track?.readyState ?? null;
      consumerInspection = await requestConsumerInspect();
      const consumerStates = consumerInspection?.result.tracks.map((track) => track.readyState) ?? [];
      if (sourceTrackState === "ended" && extensionTrackState === "ended" && consumerInspection !== null &&
        consumerInspection.result.streamPresent && consumerStates.length === 1 && consumerStates[0] === "ended") break;
      if (consumerInspection === null) break;
    }
    const consumerTrackStates = consumerInspection?.result.tracks.map((track) => track.readyState) ?? [];
    lifecycleStopObservation = {
      previousStreamId,
      previousSourceTrackId,
      previousConsumerTrackId: lastConsumerTrackId,
      sourceTrackState,
      extensionTrackState,
      consumerStreamPresent: consumerInspection?.result.streamPresent ?? false,
      consumerTrackStates,
    };
    const oldTracksEnded = sourceTrackState === "ended" && extensionTrackState === "ended" &&
      consumerInspection !== null && consumerInspection.result.streamPresent && consumerTrackStates.length === 1 &&
      consumerTrackStates[0] === "ended";
    if (consumerInspection === null) {
      updateEvidenceCheck("trackLifecycle", "UNVERIFIED", "The source was stopped, but no bounded consumer inspection response arrived; page-world track termination is unverified.", {
        stopped: lifecycleStopObservation,
        inspectTimeoutMs: CONSUMER_INSPECT_TIMEOUT_MS,
      });
    } else if (oldTracksEnded) {
      updateEvidenceCheck("trackLifecycle", "UNVERIFIED", "Stopped-track state was observed in both page contexts; restart and re-transfer are still required to prove recovery.", {
        stopped: lifecycleStopObservation,
      });
    } else {
      updateEvidenceCheck("trackLifecycle", "FAIL", "One or more source, extension-page, or consumer-page tracks did not report ended after Stop.", {
        stopped: lifecycleStopObservation,
      });
    }
    renderState();
    setStatus("#stream-status", `Offscreen stream · ${streamInfo.state}`);
    recordLog("Stopped the offscreen track and inspected actual page-world track states after a bounded settling interval.", {
      streamInfo,
      lifecycle: lifecycleStopObservation,
    });
  }));

  disposeButton.addEventListener("click", () => {
    if (disposeInProgress) return;
    disposeInProgress = true;
    renderState();
    guardedTask("Offscreen stream dispose", async () => {
      try {
        pendingWebRequestId = null;
        if (consumerReceiptTimer !== null) window.clearTimeout(consumerReceiptTimer);
        consumerReceiptTimer = null;
        let cleanupAcknowledgement: LocalConsumerDisposedMessage | null = null;
        if (consumerWindow !== null) {
          cleanupAcknowledgement = await requestConsumerDispose();
          if (cleanupAcknowledgement !== null) {
            const result = cleanupAcknowledgement.result;
            const fullyCleaned = result.completed && result.integrationState === "OFF" &&
              result.peerConnectionsClosed && result.localTracksEnded && result.error === null;
            setStatus("#consumer-status", fullyCleaned
              ? "Local consumer cleanup acknowledged · peers closed and tracks ended"
              : "Local consumer cleanup incomplete · see diagnostic result");
            recordLog("Received a validated localhost consumer cleanup acknowledgement.", {
              requestId: cleanupAcknowledgement.requestId,
              ...result,
              fullyCleaned,
            });
          } else {
            recordLog("No validated localhost cleanup acknowledgement was available; continuing extension/offscreen cleanup.");
          }
        }
        if (streamInfo?.streamId !== null && streamInfo?.streamId !== undefined) {
          streamInfo = await client.send("stream.dispose", { streamId: streamInfo.streamId });
        }
        for (const record of mediaRecords.values()) {
          await client.send("media.remove", { mediaId: record.id });
        }
        const removedSourceCount = mediaRecords.size;
        mediaRecords.clear();
        mediaRecord = null;
        updateSourceOptions();
        const extensionTrackAtCleanup = receivedStream?.getVideoTracks()[0] ?? null;
        stopTracks(receivedStream);
        const extensionTrackEnded = extensionTrackAtCleanup !== null && extensionTrackAtCleanup.readyState === "ended";
        const extensionCleanupTrack = extensionTrackAtCleanup === null ? null : trackSnapshot(extensionTrackAtCleanup);
        receivedStream = null;
        preview.pause();
        preview.srcObject = null;
        displayTrack("#track-info", null);
        renderState();
        setStatus("#stream-status", "Offscreen stream and test sources disposed");
        const consumerCleanup = cleanupAcknowledgement?.result ?? null;
        const consumerCleanupComplete = consumerCleanup !== null && consumerCleanup.completed &&
          consumerCleanup.integrationState === "OFF" && consumerCleanup.peerConnectionsClosed &&
          consumerCleanup.localTracksEnded && consumerCleanup.error === null;
        const offscreenDisposed = streamInfo?.disposed === true;
        const cleanupEvidence = {
          consumerRequestAcknowledgement: cleanupAcknowledgement === null ? null : {
            requestId: cleanupAcknowledgement.requestId,
            ...cleanupAcknowledgement.result,
          },
          consumerCleanupComplete,
          extensionPageTrack: extensionCleanupTrack,
          extensionPageTrackEnded: extensionTrackEnded,
          offscreenStreamDisposed: offscreenDisposed,
          finalStreamInfo: streamInfo,
          removedSourceCount,
        };
        const cleanupBlocked = consumerWindow === null || consumerWindow.closed || !consumerReady;
        updateEvidenceCheck("cleanup", consumerCleanupComplete && extensionTrackEnded && offscreenDisposed ? "PASS" :
          cleanupAcknowledgement === null && cleanupBlocked ? "BLOCKED" : "FAIL",
          consumerCleanupComplete && extensionTrackEnded && offscreenDisposed
            ? "The consumer acknowledged peer closure and track termination; the extension clone ended and the offscreen stream was disposed."
            : cleanupAcknowledgement === null && cleanupBlocked
              ? "The controlled consumer was unavailable for an end-to-end cleanup acknowledgement."
              : "Cleanup acknowledgement, track termination, or offscreen disposal was incomplete.",
          cleanupEvidence);
        recordLog("Disposed the offscreen stream and removed all sources ingested by this test page after the bounded localhost cleanup attempt.", cleanupEvidence);
        ingestButton.disabled = true;
        fileInput.value = "";
        selectedFile = null;
      } finally {
        disposeInProgress = false;
        renderState();
      }
    });
  });

  refreshButton.addEventListener("click", () => guardedTask("Refresh offscreen state", refreshState));

  openConsumerButton.addEventListener("click", () => guardedTask("Open localhost consumer", async () => {
    if (typeof chrome === "undefined" || chrome.runtime?.id === undefined) throw new Error("Open this page from Chrome's loaded camera-test extension.");
    const url = new URL(PHASE06_LOCAL_CONSUMER_URL);
    const extensionOrigin = window.location.origin;
    url.searchParams.set("openerOrigin", extensionOrigin);
    consumerOrigin = url.origin;
    consumerReady = false;
    pendingWebRequestId = null;
    if (consumerReceiptTimer !== null) window.clearTimeout(consumerReceiptTimer);
    consumerReceiptTimer = null;
    if (consumerReadyTimer !== null) window.clearTimeout(consumerReadyTimer);
    if (pendingConsumerInspectId !== null) finishConsumerInspect(pendingConsumerInspectId, null);
    if (pendingConsumerDisposeId !== null) finishConsumerDispose(pendingConsumerDisposeId, null);
    consumerWindow = window.open(url.href, "capcam-phase06-local-consumer");
    if (consumerWindow === null) {
      updateEvidenceCheck("consumerConnection", "BLOCKED", "Chrome blocked the explicit popup; allow the controlled localhost tab and retry.", { url: url.href });
      throw new Error("The browser blocked the localhost tab. Allow this explicit popup or open the canonical local consumer manually.");
    }
    consumerReadyTimer = window.setTimeout(() => {
      if (consumerReady) return;
      consumerReadyTimer = null;
      updateEvidenceCheck("consumerConnection", "FAIL", "The canonical localhost consumer did not complete its exact-origin ready handshake before timeout.", {
        url: url.href,
        timeoutMs: CONSUMER_READY_TIMEOUT_MS,
      });
      setStatus("#consumer-status", "Timed out waiting for the page-world consumer handshake");
      recordLog("The canonical localhost consumer did not send a validated ready handshake before the bounded timeout.", { url: url.href });
    }, CONSUMER_READY_TIMEOUT_MS);
    setStatus("#consumer-status", `Waiting for page-world handshake from ${consumerOrigin}`);
    recordLog("Opened the single canonical localhost consumer in a separate tab; no production site or content script is involved.", { url: url.href, extensionOrigin });
  }));

  requestStreamButton.addEventListener("click", () => guardedTask("Request offscreen MediaStream", async () => {
    if (channel === null) throw new Error("The camera-test BroadcastChannel is unavailable. Use npm run build:camera-test.");
    const current = await client.send("stream.getState");
    streamInfo = current;
    renderState();
    if (current.state !== "ACTIVE") throw new Error("Start the real offscreen stream before requesting it.");
    const requestId = crypto.randomUUID();
    pendingBridgeRequestId = requestId;
    requestStreamButton.disabled = true;
    if (bridgeTimer !== null) window.clearTimeout(bridgeTimer);
    bridgeTimer = window.setTimeout(() => {
      if (pendingBridgeRequestId !== requestId) return;
      recordLog("No response arrived from the offscreen BroadcastChannel probe. The bridge may be absent or MediaStream cloning may have failed.", { requestId });
      pendingBridgeRequestId = null;
      bridgeTimer = null;
      updateEvidenceCheck("offscreenCommunication", "FAIL", "No matching offscreen BroadcastChannel response arrived before the bounded timeout.", { requestId, timeoutMs: 8_000 });
      updateEvidenceCheck("mediaStreamCreation", "UNVERIFIED", "The offscreen response timed out before a MediaStream could be inspected.", { requestId });
      updateEvidenceCheck("videoTrackCreation", "UNVERIFIED", "No received MediaStream was available to inspect for a video track.", { requestId });
      requestStreamButton.disabled = false;
    }, 8_000);
    try {
      channel.postMessage({ protocol: 1, type: "get-active-stream", requestId });
      recordLog("Requested the live offscreen-owned MediaStream over the versioned same-extension-origin BroadcastChannel.", { requestId });
    } catch (error) {
      if (bridgeTimer !== null) window.clearTimeout(bridgeTimer);
      bridgeTimer = null;
      pendingBridgeRequestId = null;
      requestStreamButton.disabled = false;
      updateEvidenceCheck("offscreenCommunication", "FAIL", "Posting the versioned request to the offscreen BroadcastChannel threw.", { requestId, error: errorText(error) });
      updateEvidenceCheck("mediaStreamCreation", "UNVERIFIED", "No offscreen response was available to inspect for MediaStream creation.", { requestId });
      throw error;
    }
  }));

  window.addEventListener("message", (event: MessageEvent<unknown>) => {
    if (consumerWindow === null || consumerOrigin === null || event.origin !== consumerOrigin || event.source !== consumerWindow) return;
    if (isLocalConsumerReadyMessage(event.data)) {
      consumerReady = true;
      if (consumerReadyTimer !== null) window.clearTimeout(consumerReadyTimer);
      consumerReadyTimer = null;
      updateEvidenceCheck("consumerConnection", "PASS", "The controlled localhost page completed the versioned exact-origin ready handshake.", {
        eventOrigin: event.origin,
        consumerOrigin,
        openerOrigin: window.location.origin,
        sourceMatchesOpenedConsumerWindow: true,
      });
      setStatus("#consumer-status", `Page-world receiver ready · ${consumerOrigin}`);
      recordLog("The real localhost page-world consumer completed its exact-origin, exact-shape handshake.");
      renderState();
      if (receivedStream !== null) postReceivedStreamToConsumer();
      return;
    }
    if (isLocalConsumerDiagnosticMessage(event.data)) {
      if (event.data.type === "capcam.local-consumer.track-ended") {
        if (!consumerTransferRequestIds.has(event.data.requestId)) return;
        recordDiagnosticEvent("consumer-track-ended", event.data.requestId, {
          eventOrigin: event.origin,
          consumerOrigin,
          sourceMatchesOpenedConsumerWindow: true,
          streamId: event.data.streamId,
          track: event.data.track,
        });
        recordLog("Validated consumer-side media.track.ended event.", {
          requestId: event.data.requestId,
          streamId: event.data.streamId,
          track: event.data.track,
        });
        return;
      }
      recordDiagnosticEvent("consumer-disconnected", event.data.requestId, {
        eventOrigin: event.origin,
        consumerOrigin,
        sourceMatchesOpenedConsumerWindow: true,
        reason: event.data.reason,
        trackStateAtPagehide: event.data.result,
      });
      if (consumerReadyTimer !== null) window.clearTimeout(consumerReadyTimer);
      consumerReadyTimer = null;
      if (pendingWebRequestId !== null) {
        const interruptedRequestId = pendingWebRequestId;
        pendingWebRequestId = null;
        if (consumerReceiptTimer !== null) window.clearTimeout(consumerReceiptTimer);
        consumerReceiptTimer = null;
        updateEvidenceCheck("consumerConnection", "FAIL", "The localhost consumer disconnected before acknowledging the stream transfer.", {
          requestId: interruptedRequestId,
          disconnect: event.data.result,
        });
      }
      consumerReady = false;
      setStatus("#consumer-status", "Consumer page disconnected · pagehide state recorded");
      recordLog("The controlled localhost page sent a disconnect/pagehide diagnostic to its exact-origin opener.", {
        requestId: event.data.requestId,
        result: event.data.result,
      });
      renderState();
      return;
    }
    if (isLocalConsumerInspectedMessage(event.data) && event.data.requestId === pendingConsumerInspectId) {
      finishConsumerInspect(event.data.requestId, event.data);
      return;
    }
    if (isLocalConsumerDisposedMessage(event.data) && event.data.requestId === pendingConsumerDisposeId) {
      finishConsumerDispose(event.data.requestId, event.data);
      return;
    }
    if (isLocalConsumerReceivedMessage(event.data) && event.data.requestId === pendingWebRequestId) {
      pendingWebRequestId = null;
      if (consumerReceiptTimer !== null) window.clearTimeout(consumerReceiptTimer);
      consumerReceiptTimer = null;
      const accepted = event.data.result.accepted === true;
      const mediaStreamConfirmed = event.data.result.isMediaStream === true && event.data.result.trackCount === 1;
      const displayed = event.data.result.displayStarted === true;
      const tracks = event.data.result.tracks;
      const pageTrack = Array.isArray(tracks) && plainObject(tracks[0]) ? tracks[0] : null;
      const pageTrackLive = pageTrack?.readyState === "live" && pageTrack.kind === "video";
      const connectionPassed = accepted && mediaStreamConfirmed && pageTrackLive;
      updateEvidenceCheck("consumerConnection", connectionPassed ? "PASS" : "FAIL",
        connectionPassed ? "The exact-origin localhost page acknowledged the transferred native MediaStream and one live video track."
          : "The localhost page did not confirm an accepted MediaStream with one live video track.",
        { requestId: event.data.requestId, eventOrigin: event.origin, expectedConsumerOrigin: consumerOrigin,
          sourceMatchesOpenedConsumerWindow: true, receiverOrigin: event.data.result.receiverOrigin ?? consumerOrigin,
          accepted, isMediaStream: event.data.result.isMediaStream, trackCount: event.data.result.trackCount,
          displayStarted: displayed, tracks: tracks ?? null });
      consumerFrameEvidence = plainObject(event.data.result.frameEvidence)
        ? event.data.result.frameEvidence as unknown as LocalConsumerFrameEvidence
        : null;
      const receivedTrackId = typeof pageTrack?.id === "string" ? pageTrack.id : null;
      if (lifecycleStopObservation !== null && lifecycleRestartObservation !== null && pageTrack !== null) {
        const stopWasObserved = lifecycleStopObservation.sourceTrackState === "ended" &&
          lifecycleStopObservation.extensionTrackState === "ended" && lifecycleStopObservation.consumerStreamPresent &&
          lifecycleStopObservation.consumerTrackStates.length === 1 && lifecycleStopObservation.consumerTrackStates[0] === "ended";
        const restartedSourceIsLive = lifecycleRestartObservation.sourceTrackState === "live" &&
          lifecycleRestartObservation.sourceTrackChanged && lifecycleRestartObservation.nextTrackId !== null;
        const newConsumerTrackIsLive = pageTrack.readyState === "live" && receivedTrackId !== null &&
          (lifecycleStopObservation.previousConsumerTrackId === null || receivedTrackId !== lifecycleStopObservation.previousConsumerTrackId);
        const lifecyclePassed = stopWasObserved && restartedSourceIsLive && newConsumerTrackIsLive;
        updateEvidenceCheck("trackLifecycle", lifecyclePassed ? "PASS" : "FAIL",
          lifecyclePassed ? "The old transferred track ended in both page contexts and restart supplied a distinct live track to the localhost consumer."
            : "The stop/restart track lifecycle evidence was incomplete or inconsistent.",
          { stopped: lifecycleStopObservation, restarted: lifecycleRestartObservation,
            restartedConsumerTrack: pageTrack, restartedConsumerTrackId: receivedTrackId });
      }
      lastConsumerTrackId = receivedTrackId;
      if (connectionPassed) {
        updateFrameReceptionEvidence(event.data.requestId);
      } else {
        updateEvidenceCheck("frameReception", "FAIL", "The localhost consumer did not confirm a valid transferred video track, so actual frame reception was not established.", {
          requestId: event.data.requestId,
          extensionPage: extensionFrameEvidence,
          localConsumerPage: consumerFrameEvidence,
          consumerResult: event.data.result,
        });
      }
      setStatus("#consumer-status", connectionPassed
        ? (displayed ? "Local page acknowledged the stream · checking actual presented frames" : "Local page received the stream · preview did not start")
        : "Local page received a stream but did not confirm a valid live video track");
      recordLog("Cross-origin test result reported by the validated localhost page envelope; frame evidence is independently sampled.", event.data.result);
      renderState();
    }
  });

  window.addEventListener("pagehide", () => {
    if (bridgeTimer !== null) window.clearTimeout(bridgeTimer);
    if (consumerReadyTimer !== null) window.clearTimeout(consumerReadyTimer);
    if (consumerReceiptTimer !== null) window.clearTimeout(consumerReceiptTimer);
    consumerReadyTimer = null;
    consumerReceiptTimer = null;
    if (pendingConsumerDisposeId !== null) finishConsumerDispose(pendingConsumerDisposeId, null);
    if (pendingConsumerInspectId !== null) finishConsumerInspect(pendingConsumerInspectId, null);
    channel?.close();
    stopTracks(receivedStream);
  });
}

function setupWebConsumer(): void {
  const requestCameraButton = element<HTMLButtonElement>("#request-camera");
  const startCameraCallButton = element<HTMLButtonElement>("#start-camera-call");
  const startOffscreenCallButton = element<HTMLButtonElement>("#start-offscreen-call");
  const replaceButton = element<HTMLButtonElement>("#replace-offscreen-track");
  const cloneButton = element<HTMLButtonElement>("#clone-offscreen-track");
  const toggleEnabledButton = element<HTMLButtonElement>("#toggle-capcam-enabled");
  const rapidToggleButton = element<HTMLButtonElement>("#rapid-toggle");
  const disableButton = element<HTMLButtonElement>("#restore-camera-track");
  const closeCallButton = element<HTMLButtonElement>("#close-call");
  const cameraPreview = element<HTMLVideoElement>("#camera-preview");
  const offscreenPreview = element<HTMLVideoElement>("#offscreen-preview");
  const remotePreview = element<HTMLVideoElement>("#remote-preview");
  const integrationStatus = element<HTMLElement>("#integration-status");
  const integrationInfo = element<HTMLElement>("#integration-info");
  const testOwnedTracks = new Set<MediaStreamTrack>();
  const watchedTracks = new WeakSet<MediaStreamTrack>();
  const cameraIntegration = new CameraIntegration<MediaStreamTrack>(
    detectBrowserCameraApis,
    ({ event, details }) => recordLog(`[CameraIntegration] ${event}`, details),
  );
  let openerOrigin: string | null = null;
  let cameraStream: MediaStream | null = null;
  let cameraTrack: MediaStreamTrack | null = null;
  let offscreenStream: MediaStream | null = null;
  let loopback: LoopbackSession | null = null;
  let videoSender: RTCRtpSender | null = null;
  let senderSource: "camera" | "offscreen" | "offscreen-clone" | null = null;
  let cleanupTask: Promise<void> | null = null;
  let lifecycleGeneration = 0;
  let latestStreamRequestId: string | null = null;
  let lastCleanupResult: LocalConsumerDisposedMessage["result"] = {
    completed: false,
    integrationState: "ERROR",
    peerConnectionsClosed: false,
    localTracksEnded: false,
    error: "Cleanup has not completed.",
  };
  let detectedApis: ReturnType<typeof detectBrowserCameraApis> | null = null;

  const renderIntegrationStatus = (): void => {
    const status = cameraIntegration.getStatus();
    integrationStatus.textContent = `Local test integration · ${status.state}${status.error === null ? "" : ` · ${status.error}`}`;
    integrationInfo.textContent = JSON.stringify({
      ...status,
      senderSource,
      senderTrack: videoSender?.track === null || videoSender === null ? null : trackSnapshot(videoSender.track),
      pageApis: detectedApis,
    }, null, 2);
  };

  const updateConsumerButtons = (): void => {
    const integrationState = cameraIntegration.getStatus().state;
    const integrationActive = integrationState === "ACTIVE";
    const targetUnsupported = integrationState === "TARGET_UNSUPPORTED";
    const hasLiveVirtualTrack = offscreenStream?.getVideoTracks().some((track) => track.kind === "video" && track.readyState === "live") ?? false;
    requestCameraButton.disabled = cameraStream !== null;
    startCameraCallButton.disabled = cameraStream === null || loopback !== null;
    startOffscreenCallButton.disabled = offscreenStream === null || loopback !== null;
    replaceButton.disabled = videoSender === null || !hasLiveVirtualTrack || senderSource !== "camera" || integrationActive || targetUnsupported;
    cloneButton.disabled = videoSender === null || !hasLiveVirtualTrack || !integrationActive || targetUnsupported;
    toggleEnabledButton.disabled = videoSender?.track === null || videoSender === null || !integrationActive;
    rapidToggleButton.disabled = videoSender === null || cameraTrack?.readyState !== "live" || !hasLiveVirtualTrack ||
      (senderSource !== "camera" && !integrationActive);
    disableButton.disabled = !integrationActive && integrationState !== "DISCONNECTED" && integrationState !== "ERROR";
    closeCallButton.disabled = loopback === null;
    renderIntegrationStatus();
  };

  const watchTrack = (
    track: MediaStreamTrack,
    source: string,
    correlation: { requestId: string; streamId: string } | null = null,
  ): void => {
    if (watchedTracks.has(track)) return;
    watchedTracks.add(track);
    track.addEventListener("ended", () => {
      const snapshot = trackSnapshot(track);
      recordLog("media.track.ended", { source, requestId: correlation?.requestId ?? null, track: snapshot });
      if (correlation !== null && snapshot.readyState === "ended") {
        sendConsumerDiagnostic({
          protocol: LOCAL_CONSUMER_PROTOCOL_VERSION,
          type: "capcam.local-consumer.track-ended",
          requestId: correlation.requestId,
          streamId: correlation.streamId,
          track: snapshot as unknown as LocalConsumerTrackSnapshot,
        });
      }
      if (cameraIntegration.getStatus().activeTrackId !== track.id) {
        updateConsumerButtons();
        return;
      }
      void cameraIntegration.handleTrackEnded(track.id).then((status) => {
        senderSource = videoSender?.track === cameraTrack ? "camera" : videoSender?.track === null ? null : senderSource;
        recordLog("Integration recovered after its active video track ended.", status);
        updateConsumerButtons();
      }).catch((error: unknown) => {
        setStatus("#consumer-status", `Integration recovery failed · ${errorText(error)}`);
        updateConsumerButtons();
      });
    }, { once: true });
    track.addEventListener("mute", () => recordLog("media.track.muted", { source, track: trackSnapshot(track) }));
    track.addEventListener("unmute", () => recordLog("media.track.unmuted", { source, track: trackSnapshot(track) }));
  };

  const sendConsumerResult = (requestId: string, result: Record<string, unknown>): void => {
    const targetOrigin = openerOrigin;
    if (targetOrigin === null) return;
    window.opener?.postMessage({ protocol: LOCAL_CONSUMER_PROTOCOL_VERSION, type: "capcam.local-consumer.received", requestId, result }, targetOrigin);
  };

  const sendConsumerDiagnostic = (message: LocalConsumerDiagnosticMessage): void => {
    const targetOrigin = openerOrigin;
    if (targetOrigin === null || window.opener === null) return;
    try {
      window.opener.postMessage(message, targetOrigin);
    } catch (error) {
      recordLog("Could not send a consumer lifecycle diagnostic to the extension opener.", {
        type: message.type,
        requestId: message.requestId,
        error: errorText(error),
      });
    }
  };

  const consumerTrackSetSnapshot = (): LocalConsumerInspectedMessage["result"] => {
    const stream = offscreenStream;
    const tracks = stream?.getVideoTracks().map((track) => trackSnapshot(track) as unknown as LocalConsumerTrackSnapshot) ?? [];
    return {
      streamPresent: stream !== null,
      streamId: stream?.id ?? null,
      streamActive: stream?.active ?? null,
      trackCount: stream?.getTracks().length ?? 0,
      tracks,
    };
  };

  try {
    const requestedOrigin = new URLSearchParams(window.location.search).get("openerOrigin");
    if (requestedOrigin === null || !requestedOrigin.startsWith("chrome-extension://") || new URL(requestedOrigin).origin !== requestedOrigin) {
      throw new Error("Missing or invalid extension opener origin. Open this page from the test extension button.");
    }
    openerOrigin = requestedOrigin;
  } catch (error) {
    setStatus("#consumer-status", errorText(error));
    integrationStatus.textContent = "TARGET_UNSUPPORTED · no trusted test opener";
    recordLog("The localhost page refused stream messages because the explicit extension opener origin is missing or invalid.", { error: errorText(error) });
    return;
  }

  detectedApis = cameraIntegration.detect();
  recordLog("target.detected · controlled localhost consumer", {
    pageOrigin: window.location.origin,
    extensionTestOrigin: openerOrigin,
    supportedApis: detectedApis,
  });
  void cameraIntegration.initialize().then((status) => {
    setStatus("#consumer-status", status.state === "READY" ? "Controlled page APIs ready · native getUserMedia remains unmodified" : status.error ?? status.state);
    updateConsumerButtons();
  }).catch((error: unknown) => {
    setStatus("#consumer-status", `Integration initialization failed · ${errorText(error)}`);
    updateConsumerButtons();
  });
  updateConsumerButtons();

  requestCameraButton.addEventListener("click", () => guardedTask("Local page native camera", async () => {
    if (cameraStream !== null) throw new Error("The native local camera is already active.");
    const nativeGetUserMedia = navigator.mediaDevices?.getUserMedia;
    if (typeof nativeGetUserMedia !== "function") throw new Error("Native getUserMedia requires a secure local origin such as localhost.");
    recordLog("Calling the page's original navigator.mediaDevices.getUserMedia({ audio: false, video: true }) after an explicit click; CapCam does not patch or bypass the browser permission prompt.");
    cameraStream = await nativeGetUserMedia.call(navigator.mediaDevices, { audio: false, video: true });
    cameraTrack = cameraStream.getVideoTracks()[0] ?? null;
    if (cameraTrack === null || cameraTrack.kind !== "video" || cameraTrack.readyState !== "live") {
      stopTracks(cameraStream);
      cameraStream = null;
      cameraTrack = null;
      throw new Error("The browser did not return a live native video track.");
    }
    watchTrack(cameraTrack, "native-camera");
    cameraPreview.srcObject = cameraStream;
    try {
      await cameraPreview.play();
    } catch (error) {
      stopTracks(cameraStream);
      cameraStream = null;
      cameraTrack = null;
      cameraPreview.srcObject = null;
      throw error;
    }
    displayTrack("#camera-track-info", cameraStream);
    setStatus("#consumer-status", "Native camera permission granted · page-owned track is live");
    recordLog("Page-visible native getUserMedia track.", trackSnapshot(cameraTrack));
    updateConsumerButtons();
  }));

  startCameraCallButton.addEventListener("click", () => guardedTask("Native camera addTrack", async () => {
    if (cameraStream === null) throw new Error("Acquire the native camera first.");
    loopback = await createLoopback(cameraStream, remotePreview, recordLog);
    videoSender = loopback.senders.find((sender) => sender.track?.kind === "video") ?? null;
    const senderTrack = videoSender?.track ?? null;
    senderSource = "camera";
    if (videoSender === null || senderTrack === null) throw new Error("The camera track was not added to a sender.");
    setStatus("#consumer-status", "Connected · local sender uses native camera");
    element<HTMLElement>("#sender-info").textContent = JSON.stringify({ track: trackSnapshot(senderTrack), source: senderSource }, null, 2);
    updateConsumerButtons();
  }));

  startOffscreenCallButton.addEventListener("click", () => guardedTask("Offscreen track addTrack", async () => {
    if (offscreenStream === null) throw new Error("Receive the offscreen stream first.");
    loopback = await createLoopback(offscreenStream, remotePreview, recordLog);
    videoSender = loopback.senders.find((sender) => sender.track?.kind === "video") ?? null;
    const senderTrack = videoSender?.track ?? null;
    senderSource = "offscreen";
    if (videoSender === null || senderTrack === null) throw new Error("The received offscreen track was not added to a sender.");
    setStatus("#consumer-status", "Connected · sender uses received offscreen track");
    element<HTMLElement>("#sender-info").textContent = JSON.stringify({ track: trackSnapshot(senderTrack), source: senderSource }, null, 2);
    updateConsumerButtons();
  }));

  replaceButton.addEventListener("click", () => guardedTask("Enable controlled CapCam sender", async () => {
    if (videoSender === null || offscreenStream === null || senderSource !== "camera") {
      throw new Error("For this permission-preserving test, first acquire the native camera and start its WebRTC call.");
    }
    const replacementTrack = offscreenStream.getVideoTracks().find((track) => track.kind === "video");
    if (replacementTrack === undefined || replacementTrack.readyState !== "live") throw new Error("The received CapCam source has no live video track.");
    const previousTrack = videoSender.track;
    const status = await cameraIntegration.enable(videoSender, replacementTrack);
    senderSource = "offscreen";
    watchTrack(replacementTrack, "offscreen-camera-source");
    const result = {
      previousTrack: previousTrack === null ? null : trackSnapshot(previousTrack),
      requestedTrack: trackSnapshot(replacementTrack),
      senderNowUses: videoSender.track === null ? null : trackSnapshot(videoSender.track),
      senderTrackMatches: videoSender.track?.id === replacementTrack.id,
      signalingState: loopback?.senderPeer.signalingState ?? "closed",
      connectionState: loopback?.senderPeer.connectionState ?? "closed",
      integration: status,
    };
    element<HTMLElement>("#sender-info").textContent = JSON.stringify(result, null, 2);
    setStatus("#consumer-status", "CapCam track attached after native camera permission · inspect remote video");
    recordLog("The local CameraIntegration explicitly called RTCRtpSender.replaceTrack() with the live offscreen video track.", result);
    updateConsumerButtons();
  }));

  cloneButton.addEventListener("click", () => guardedTask("Clone CapCam track", async () => {
    const original = offscreenStream?.getVideoTracks().find((track) => track.kind === "video");
    if (videoSender === null || original === undefined || original.readyState !== "live") throw new Error("A live received CapCam track and active sender are required.");
    const clone = original.clone();
    if (clone.kind !== "video" || clone.readyState !== "live") {
      clone.stop();
      throw new Error("MediaStreamTrack.clone() did not return a live video track.");
    }
    testOwnedTracks.add(clone);
    watchTrack(clone, "offscreen-track-clone");
    recordLog("media.track.cloned", { original: trackSnapshot(original), clone: trackSnapshot(clone) });
    let status: CameraIntegrationStatus;
    try {
      status = await cameraIntegration.replaceTrack(clone);
    } catch (error) {
      clone.stop();
      testOwnedTracks.delete(clone);
      throw error;
    }
    senderSource = "offscreen-clone";
    element<HTMLElement>("#sender-info").textContent = JSON.stringify({ senderTrack: videoSender.track === null ? null : trackSnapshot(videoSender.track), integration: status }, null, 2);
    setStatus("#consumer-status", "Sender replaced with a live CapCam track clone");
    updateConsumerButtons();
  }));

  toggleEnabledButton.addEventListener("click", () => guardedTask("Toggle CapCam track enabled", async () => {
    const track = videoSender?.track;
    if (track === null || track === undefined || track.readyState !== "live") throw new Error("There is no live sender track to toggle.");
    track.enabled = !track.enabled;
    element<HTMLElement>("#sender-info").textContent = JSON.stringify({ senderSource, track: trackSnapshot(track) }, null, 2);
    setStatus("#consumer-status", `Attached ${track.kind} track enabled=${track.enabled}`);
    recordLog("media.track.enabled-changed", { senderSource, track: trackSnapshot(track) });
    updateConsumerButtons();
  }));

  rapidToggleButton.addEventListener("click", () => guardedTask("Rapid CapCam toggle test", async () => {
    if (videoSender === null || cameraTrack?.readyState !== "live") throw new Error("Acquire the native camera and start its call first.");
    const virtualTrack = offscreenStream?.getVideoTracks().find((track) => track.kind === "video");
    if (virtualTrack === undefined || virtualTrack.readyState !== "live") throw new Error("Receive a live CapCam video track first.");
    for (let cycle = 1; cycle <= 5; cycle += 1) {
      const active = await cameraIntegration.enable(videoSender, virtualTrack);
      if (active.state !== "ACTIVE" || videoSender.track?.readyState !== "live") throw new Error(`ON cycle ${cycle} did not attach a live track.`);
      const disabled = await cameraIntegration.disable();
      if (disabled.state !== "OFF" || videoSender.track?.id !== cameraTrack.id) throw new Error(`OFF cycle ${cycle} did not restore the native track.`);
      recordLog("camera.integration.toggle-cycle", { cycle, result: "OFF → ON → OFF", nativeTrack: trackSnapshot(cameraTrack), virtualTrack: trackSnapshot(virtualTrack) });
    }
    senderSource = "camera";
    setStatus("#consumer-status", "5 ON/OFF cycles completed in the controlled local test; native camera restored");
    updateConsumerButtons();
  }));

  disableButton.addEventListener("click", () => guardedTask("Disable CapCam integration", async () => {
    const status = await cameraIntegration.disable();
    senderSource = videoSender?.track === cameraTrack ? "camera" : videoSender?.track === null ? null : senderSource;
    for (const track of testOwnedTracks) {
      if (track !== videoSender?.track) {
        track.stop();
        testOwnedTracks.delete(track);
      }
    }
    element<HTMLElement>("#sender-info").textContent = JSON.stringify({
      senderTrack: videoSender?.track === null || videoSender === null ? null : trackSnapshot(videoSender.track),
      physicalCameraStillLive: cameraTrack?.readyState === "live",
      integration: status,
    }, null, 2);
    setStatus("#consumer-status", status.error ?? "CapCam disabled · original native camera restored");
    recordLog("camera.integration.disabled · the native getUserMedia implementation remains untouched and the original camera track is still available.", {
      status,
      senderTrack: videoSender?.track === null || videoSender === null ? null : trackSnapshot(videoSender.track),
      cameraTrack: cameraTrack === null ? null : trackSnapshot(cameraTrack),
    });
    updateConsumerButtons();
  }));

  const cleanup = async (): Promise<void> => {
    if (cleanupTask !== null) return cleanupTask;
    lifecycleGeneration += 1;
    lastCleanupResult = {
      completed: false,
      integrationState: "ERROR",
      peerConnectionsClosed: false,
      localTracksEnded: false,
      error: "Cleanup did not finish.",
    };
    cleanupTask = (async () => {
      let cleanupError: string | null = null;
      const noteCleanupError = (error: unknown): void => {
        const message = errorText(error);
        cleanupError = cleanupError === null ? message : `${cleanupError}; ${message}`;
      };
      const peers = loopback === null ? [] : [loopback.senderPeer, loopback.receiverPeer];
      const ownedTracks = new Set<MediaStreamTrack>();
      for (const stream of [cameraStream, offscreenStream]) {
        for (const track of stream?.getTracks() ?? []) ownedTracks.add(track);
      }
      for (const video of [cameraPreview, offscreenPreview, remotePreview]) {
        if (video.srcObject instanceof MediaStream) {
          for (const track of video.srcObject.getTracks()) ownedTracks.add(track);
        }
      }
      for (const track of testOwnedTracks) ownedTracks.add(track);

      try {
        const status = await cameraIntegration.destroy();
        if (status.error !== null) noteCleanupError(status.error);
      } catch (error) {
        noteCleanupError(error);
        recordLog("CameraIntegration destroy failed; closing the local peer remains the final test cleanup boundary.", { error: errorText(error) });
      }
      try {
        loopback?.close();
      } catch (error) {
        noteCleanupError(error);
        recordLog("Closing the localhost WebRTC peers raised an error.", { error: errorText(error) });
      }
      loopback = null;
      videoSender = null;
      senderSource = null;
      for (const track of ownedTracks) {
        try {
          track.stop();
        } catch (error) {
          noteCleanupError(error);
        }
      }
      testOwnedTracks.clear();
      cameraStream = null;
      cameraTrack = null;
      offscreenStream = null;
      for (const video of [cameraPreview, offscreenPreview, remotePreview]) {
        try {
          video.pause();
          video.srcObject = null;
        } catch (error) {
          noteCleanupError(error);
        }
      }
      displayTrack("#camera-track-info", null);
      displayTrack("#offscreen-track-info", null);
      element<HTMLElement>("#sender-info").textContent = "No sender.";
      requestCameraButton.disabled = false;
      const status = cameraIntegration.getStatus();
      if (status.error !== null) noteCleanupError(status.error);
      const peerConnectionsClosed = peers.every((peer) => peer.signalingState === "closed");
      const localTracksEnded = [...ownedTracks].every((track) => track.readyState === "ended");
      if (!peerConnectionsClosed) noteCleanupError("At least one local RTCPeerConnection did not reach closed state.");
      if (!localTracksEnded) noteCleanupError("At least one page-owned local media track did not reach ended state.");
      if (status.state !== "OFF" && status.state !== "TARGET_UNSUPPORTED") {
        noteCleanupError(`CameraIntegration remained in ${status.state} after destroy.`);
      }
      const integrationState = status.state === "OFF" ? "OFF" :
        status.state === "TARGET_UNSUPPORTED" ? "TARGET_UNSUPPORTED" : "ERROR";
      const boundedError = cleanupError === null ? null : cleanupError.slice(0, 400);
      lastCleanupResult = {
        completed: status.state === "OFF" && peerConnectionsClosed && localTracksEnded && cleanupError === null,
        integrationState,
        peerConnectionsClosed,
        localTracksEnded,
        error: boundedError,
      };
      setStatus("#consumer-status", lastCleanupResult.completed
        ? "Test integration destroyed · local tracks and peers stopped"
        : "Test cleanup incomplete · inspect the cleanup acknowledgement");
      recordLog("integration.destroyed · the controlled test page measured peer closure and page-owned track termination.", {
        integration: status,
        cleanup: lastCleanupResult,
      });
      updateConsumerButtons();
    })();
    try {
      await cleanupTask;
    } finally {
      cleanupTask = null;
    }
  };

  closeCallButton.addEventListener("click", () => guardedTask("Close local call", cleanup));
  window.addEventListener("pagehide", () => {
    const diagnosticRequestId = latestStreamRequestId ?? crypto.randomUUID();
    const result = consumerTrackSetSnapshot();
    sendConsumerDiagnostic({
      protocol: LOCAL_CONSUMER_PROTOCOL_VERSION,
      type: "capcam.local-consumer.disconnected",
      requestId: diagnosticRequestId,
      reason: "pagehide",
      result,
    });
    recordLog("consumer.pagehide · sending a bounded track/disconnect snapshot to the exact opener before cleanup.", {
      requestId: diagnosticRequestId,
      result,
    });
    void cleanup();
  });

  const sendCleanupAcknowledgement = (requestId: string, failure?: unknown): void => {
    const targetOrigin = openerOrigin;
    const targetWindow = window.opener;
    if (targetOrigin === null || targetWindow === null) return;
    if (failure !== undefined) {
      const status = cameraIntegration.getStatus();
      lastCleanupResult = {
        ...lastCleanupResult,
        completed: false,
        integrationState: status.state === "OFF" ? "OFF" :
          status.state === "TARGET_UNSUPPORTED" ? "TARGET_UNSUPPORTED" : "ERROR",
        error: errorText(failure).slice(0, 400),
      };
    }
    try {
      targetWindow.postMessage({
        protocol: LOCAL_CONSUMER_PROTOCOL_VERSION,
        type: "capcam.local-consumer.disposed",
        requestId,
        result: lastCleanupResult,
      }, targetOrigin);
      recordLog("Sent the validated cleanup result to the exact extension-origin opener.", {
        requestId,
        ...lastCleanupResult,
      });
    } catch (error) {
      recordLog("Could not send the localhost cleanup acknowledgement to its extension opener.", {
        requestId,
        error: errorText(error),
      });
    }
  };

  window.addEventListener("message", (event: MessageEvent<unknown>) => {
    if (openerOrigin === null || event.origin !== openerOrigin || event.source !== window.opener || !isLocalConsumerDisposeMessage(event.data)) return;
    const { requestId } = event.data;
    void cleanup().then(() => sendCleanupAcknowledgement(requestId)).catch((error: unknown) => {
      sendCleanupAcknowledgement(requestId, error);
    });
  });

  window.addEventListener("message", (event: MessageEvent<unknown>) => {
    if (openerOrigin === null || event.origin !== openerOrigin || event.source !== window.opener || !isLocalConsumerInspectMessage(event.data)) return;
    const result = consumerTrackSetSnapshot();
    try {
      window.opener?.postMessage({
        protocol: LOCAL_CONSUMER_PROTOCOL_VERSION,
        type: "capcam.local-consumer.inspected",
        requestId: event.data.requestId,
        result,
      }, openerOrigin);
      recordLog("Returned a bounded track-state inspection to the exact extension-origin opener.", { requestId: event.data.requestId, result });
    } catch (error) {
      recordLog("Could not send the consumer track-state inspection to the extension opener.", { requestId: event.data.requestId, error: errorText(error) });
    }
  });

  window.addEventListener("message", (event: MessageEvent<unknown>) => {
    if (openerOrigin === null || event.origin !== openerOrigin || event.source !== window.opener || !isLocalConsumerStreamMessage(event.data, (candidate): candidate is MediaStream => candidate instanceof MediaStream)) return;
    const { requestId, stream } = event.data;
    const videoTracks = stream.getVideoTracks();
    const audioTracks = stream.getAudioTracks();
    const track = videoTracks[0];
    if (videoTracks.length !== 1 || audioTracks.length !== 0 || track === undefined || track.kind !== "video" || track.readyState !== "live") {
      const result = {
        accepted: false,
        displayStarted: false,
        isMediaStream: true,
        trackCount: stream.getTracks().length,
        message: "Expected exactly one live video track and no audio tracks in the controlled video-only source.",
      };
      sendConsumerResult(requestId, result);
      recordLog("virtual.track.rejected", { result, tracks: stream.getTracks().map(trackSnapshot) });
      stopTracks(stream);
      setStatus("#consumer-status", "INTEGRATION_ERROR · received CapCam stream is not one live video track");
      return;
    }

    const receiveGeneration = lifecycleGeneration;
    const previousStream = offscreenStream;
    offscreenStream = stream;
    latestStreamRequestId = requestId;
    watchTrack(track, "offscreen-camera-source", { requestId, streamId: stream.id });
    offscreenPreview.srcObject = stream;
    displayTrack("#offscreen-track-info", stream);
    recordLog("virtual.track.created-and-received", {
      context: "controlled-local-page",
      streamId: stream.id,
      track: trackSnapshot(track),
      sourceLabel: "CapCam virtual video · local test bridge",
    });
    void offscreenPreview.play().then(async () => {
      if (receiveGeneration !== lifecycleGeneration) {
        stopTracks(stream);
        return;
      }
      if (previousStream !== null && previousStream !== stream && cameraIntegration.getStatus().state === "ACTIVE") {
        await cameraIntegration.replaceTrack(track);
        if (receiveGeneration !== lifecycleGeneration) {
          stopTracks(stream);
          return;
        }
        senderSource = "offscreen";
        stopTracks(previousStream);
      } else if (previousStream !== null && previousStream !== stream) {
        stopTracks(previousStream);
      }
      if (receiveGeneration !== lifecycleGeneration) {
        stopTracks(stream);
        return;
      }
      const frameEvidence = await samplePresentedFrames(offscreenPreview);
      if (receiveGeneration !== lifecycleGeneration) {
        stopTracks(stream);
        return;
      }
      const result = {
        accepted: true,
        displayStarted: true,
        isMediaStream: true,
        streamId: stream.id,
        trackCount: stream.getTracks().length,
        tracks: stream.getTracks().map(trackSnapshot),
        receiverOrigin: window.location.origin,
        frameEvidence,
      };
      setStatus("#consumer-status", frameEvidence.frameCount > 0
        ? `Offscreen stream received · ${frameEvidence.frameCount} actual frames presented`
        : "Offscreen stream received · no presented frame observed in sample");
      recordLog("The local test page sampled presented frames with requestVideoFrameCallback; play() resolution is recorded separately and does not count as frame evidence.", result);
      sendConsumerResult(requestId, result);
      updateConsumerButtons();
    }).catch(async (error: unknown) => {
      if (receiveGeneration !== lifecycleGeneration) {
        stopTracks(stream);
        return;
      }
      const frameEvidence = await samplePresentedFrames(offscreenPreview, 500);
      const result = {
        accepted: true,
        displayStarted: false,
        isMediaStream: true,
        trackCount: stream.getTracks().length,
        tracks: stream.getTracks().map(trackSnapshot),
        receiverOrigin: window.location.origin,
        frameEvidence,
        error: errorText(error),
      };
      recordLog("A MediaStream reached the localhost page, but its video preview did not start; the consumer still reports an explicit frame sample.", result);
      sendConsumerResult(requestId, result);
      setStatus("#consumer-status", `INTEGRATION_ERROR · preview rejected · ${errorText(error)}`);
      updateConsumerButtons();
    });
  });

  window.addEventListener("message", (event: MessageEvent<unknown>) => {
    if (openerOrigin === null || event.origin !== openerOrigin || event.source !== window.opener || !isLocalConsumerReadyMessage(event.data)) return;
    setStatus("#consumer-status", "Page-world handshake received · ready for explicit local stream transfer");
    recordLog("Target detected: this is the controlled localhost page opened by the test extension; APIs remain page-owned.", {
      extensionOrigin: openerOrigin,
      pageOrigin: window.location.origin,
    });
  });

  window.addEventListener("messageerror", () => {
    recordLog("The localhost page fired messageerror while deserializing the extension page's MediaStream message.");
    setStatus("#consumer-status", "INTEGRATION_ERROR · MediaStream message deserialization error");
  });

  setStatus("#consumer-status", "Waiting for the extension page handshake");
  window.opener?.postMessage({ protocol: LOCAL_CONSUMER_PROTOCOL_VERSION, type: "capcam.local-consumer.ready" }, openerOrigin);
  recordLog("This normal localhost page is listening for a message from the exact extension-origin opener.", {
    openerOrigin,
    receiverOrigin: window.location.origin,
    getUserMediaOverridden: false,
  });
}

function setupTransferReceiver(): void {
  const preview = element<HTMLVideoElement>("#receiver-preview");
  const info = element<HTMLElement>("#receiver-info");

  window.addEventListener("message", (event: MessageEvent<unknown>) => {
    if (event.origin !== window.location.origin || event.source !== window.parent || !plainObject(event.data)) return;
    if (event.data.type !== TRANSFER_MESSAGE || typeof event.data.probeId !== "string") return;
    const probeId = event.data.probeId;
    const stream = event.data.stream;
    if (!(stream instanceof MediaStream)) {
      const result = { accepted: false, displayStarted: false, isMediaStream: false, trackCount: 0, message: "Received value is not a MediaStream in the iframe page world." };
      info.textContent = JSON.stringify(result, null, 2);
      window.parent.postMessage({ type: TRANSFER_RESULT_MESSAGE, probeId, result }, window.location.origin);
      return;
    }

    const previousStream = preview.srcObject instanceof MediaStream ? preview.srcObject : null;
    if (previousStream !== stream) stopTracks(previousStream);
    const tracks = stream.getTracks();
    preview.srcObject = stream;
    void preview.play().then(() => {
      const result = {
        accepted: true,
        displayStarted: true,
        isMediaStream: true,
        streamId: stream.id,
        trackCount: tracks.length,
        tracks: tracks.map(trackSnapshot),
      };
      info.textContent = JSON.stringify(result, null, 2);
      window.parent.postMessage({ type: TRANSFER_RESULT_MESSAGE, probeId, result }, window.location.origin);
    }).catch((error: unknown) => {
      const result = {
        accepted: true,
        displayStarted: false,
        isMediaStream: true,
        streamId: stream.id,
        trackCount: tracks.length,
        tracks: tracks.map(trackSnapshot),
        error: errorText(error),
      };
      info.textContent = JSON.stringify(result, null, 2);
      window.parent.postMessage({ type: TRANSFER_RESULT_MESSAGE, probeId, result }, window.location.origin);
    });
  });

  window.addEventListener("messageerror", () => {
    info.textContent = "The browser could not deserialize the incoming message in this iframe context.";
  });
  window.addEventListener("pagehide", () => {
    stopTracks(preview.srcObject instanceof MediaStream ? preview.srcObject : null);
    preview.pause();
    preview.srcObject = null;
  });
  window.parent.postMessage({ type: RECEIVER_READY_MESSAGE }, window.location.origin);
}

const pageMode = document.body.dataset.testPage;
switch (pageMode) {
  case "index":
    break;
  case "basic-camera":
    setupBasicCamera();
    break;
  case "capcam-stream":
    setupCapcamStream();
    break;
  case "loopback":
    setupLoopback();
    break;
  case "replace-track":
    setupReplaceTrack();
    break;
  case "offscreen-bridge":
    setupOffscreenBridge();
    break;
  case "web-consumer":
    setupWebConsumer();
    break;
  case "transfer-receiver":
    setupTransferReceiver();
    break;
  default:
    throw new Error(`Unknown WebRTC test page mode: ${String(pageMode)}.`);
}
