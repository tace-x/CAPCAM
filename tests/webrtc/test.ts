import { DEFAULT_RENDER_CONFIG, type RenderConfig, type RenderableMediaSource } from "../../src/canvas/render-types";
import { MediaIngestClient } from "../../src/media/media-ingest-client";
import type { MediaRecord } from "../../src/media/media-types";
import { MessagingClient } from "../../src/messaging/client";
import { OFFSCREEN_STREAM_BRIDGE_CHANNEL, isOffscreenStreamBridgeResponse } from "../../src/shared/camera-test-bridge";
import { CanvasStreamPipeline } from "../../src/stream/canvas-stream-pipeline";
import type { StreamInfo, StreamMediaSourceProvider } from "../../src/stream/stream-types";
import "./webrtc.css";

type LogFunction = (message: string, details?: unknown) => void;
type SourceRecord = { source: RenderableMediaSource; objectUrl: string; fileName: string };

const MAX_LOCAL_FILE_BYTES = 512 * 1024 * 1024;
const TRANSFER_MESSAGE = "capcam.webrtc.stream-probe";
const TRANSFER_RESULT_MESSAGE = "capcam.webrtc.stream-probe-result";
const RECEIVER_READY_MESSAGE = "capcam.webrtc.receiver-ready";

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
  return {
    kind: track.kind,
    id: track.id,
    label: track.label,
    readyState: track.readyState,
    enabled: track.enabled,
    muted: track.muted,
    settings: track.getSettings(),
  };
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
      } else {
        record.source.element.removeAttribute("src");
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
  const stopButton = element<HTMLButtonElement>("#stop-stream");
  const disposeButton = element<HTMLButtonElement>("#dispose-stream");
  const refreshButton = element<HTMLButtonElement>("#refresh-state");
  const openConsumerButton = element<HTMLButtonElement>("#open-consumer");
  const requestStreamButton = element<HTMLButtonElement>("#request-offscreen-stream");
  const consumerUrlInput = element<HTMLInputElement>("#consumer-url");
  const preview = element<HTMLVideoElement>("#extension-preview");
  const stateOutput = element<HTMLElement>("#offscreen-state");
  const client = new MessagingClient();
  const ingestClient = new MediaIngestClient(client);
  const cameraTestBuild = import.meta.env.MODE === "camera-test";
  let channel: BroadcastChannel | null = null;
  let selectedFile: File | null = null;
  let mediaRecord: MediaRecord | null = null;
  let streamInfo: StreamInfo | null = null;
  let receivedStream: MediaStream | null = null;
  let consumerWindow: Window | null = null;
  let consumerOrigin: string | null = null;
  let consumerReady = false;
  let pendingBridgeRequestId: string | null = null;
  let pendingWebRequestId: string | null = null;
  let bridgeTimer: number | null = null;

  const renderState = (): void => {
    stateOutput.textContent = JSON.stringify({
      media: mediaRecord === null ? null : { id: mediaRecord.id, name: mediaRecord.name, kind: mediaRecord.kind, status: mediaRecord.status },
      stream: streamInfo,
    }, null, 2);
    const hasStream = streamInfo?.streamId !== null && streamInfo?.streamId !== undefined && !streamInfo.disposed;
    createButton.disabled = mediaRecord === null || hasStream;
    startButton.disabled = !hasStream || streamInfo?.state !== "READY";
    restartButton.disabled = !hasStream || streamInfo?.state === "ACTIVE";
    stopButton.disabled = !hasStream || streamInfo?.state !== "ACTIVE";
    disposeButton.disabled = !hasStream;
    requestStreamButton.disabled = !cameraTestBuild || channel === null || !consumerReady || streamInfo?.state !== "ACTIVE";
  };

  const refreshState = async (): Promise<void> => {
    streamInfo = await client.send("stream.getState");
    renderState();
    setStatus("#stream-status", streamInfo.streamId === null ? "No offscreen stream" : `Offscreen stream · ${streamInfo.state}`);
  };

  const postReceivedStreamToConsumer = (): void => {
    if (receivedStream === null || consumerWindow === null || consumerOrigin === null || !consumerReady) return;
    if (consumerWindow.closed) {
      consumerWindow = null;
      consumerOrigin = null;
      consumerReady = false;
      setStatus("#consumer-status", "Consumer tab closed");
      renderState();
      return;
    }
    const requestId = crypto.randomUUID();
    pendingWebRequestId = requestId;
    try {
      consumerWindow.postMessage({
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
      setStatus("#consumer-status", "window.postMessage cloning failed");
      recordLog("Cross-origin window.postMessage threw while cloning the active offscreen MediaStream.", { error: errorText(error) });
    }
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
        renderState();
        if (event.data.type === "error") {
          setStatus("#stream-status", "Offscreen bridge returned an error");
          recordLog("Offscreen test bridge could not provide an active stream.", { message: event.data.message });
          requestStreamButton.disabled = false;
          return;
        }
        const stream = event.data.stream;
        if (!(stream instanceof MediaStream)) {
          setStatus("#stream-status", "Received value was not a MediaStream in this extension page");
          recordLog("BroadcastChannel response arrived, but the extension page did not receive a native MediaStream object.");
          return;
        }
        stopTracks(receivedStream);
        receivedStream = stream;
        preview.srcObject = stream;
        displayTrack("#track-info", stream);
        void preview.play().then(() => {
          setStatus("#stream-status", "Actual offscreen track received and displayed in extension page");
          recordLog("The extension test page received and displayed the offscreen-owned stream through BroadcastChannel structured cloning.", {
            streamId: stream.id,
            tracks: stream.getTracks().map(trackSnapshot),
          });
          postReceivedStreamToConsumer();
        }).catch((error: unknown) => {
          setStatus("#stream-status", "Received stream · preview rejected by browser");
          recordLog("The extension page received a MediaStream object but could not start its preview.", { error: errorText(error) });
        });
      });
      channel.addEventListener("messageerror", () => {
        pendingBridgeRequestId = null;
        if (bridgeTimer !== null) window.clearTimeout(bridgeTimer);
        bridgeTimer = null;
        setStatus("#stream-status", "BroadcastChannel deserialization error");
        recordLog("The extension page received a messageerror while deserializing the offscreen stream response.");
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

  ingestButton.addEventListener("click", () => guardedTask("Offscreen media ingest", async () => {
    if (selectedFile === null) throw new Error("Choose a local file first.");
    setStatus("#stream-status", "Staging temporary local-file handoff…");
    mediaRecord = await ingestClient.ingest(selectedFile);
    streamInfo = null;
    setStatus("#stream-status", `Offscreen media ready · ${mediaRecord.name}`);
    recordLog("MediaIngestClient staged the selected file in the existing temporary IndexedDB handoff, then sent only a transfer ID through the typed runtime protocol.", {
      id: mediaRecord.id,
      name: mediaRecord.name,
      kind: mediaRecord.kind,
      bytes: mediaRecord.size,
      status: mediaRecord.status,
    });
    renderState();
    ingestButton.disabled = true;
  }));

  createButton.addEventListener("click", () => guardedTask("Offscreen stream create", async () => {
    if (mediaRecord === null) throw new Error("Ingest a local image or video first.");
    const config: RenderConfig = { ...DEFAULT_RENDER_CONFIG, width: 1280, height: 720, fps: 30 };
    streamInfo = await client.send("stream.create", { mediaId: mediaRecord.id, config });
    renderState();
    setStatus("#stream-status", `Created · ${streamInfo.state} · click Start`);
    recordLog("Created the production offscreen-owned CanvasStreamPipeline through the existing typed runtime command.", streamInfo);
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
    streamInfo = await client.send("stream.restart", { streamId: streamInfo.streamId });
    renderState();
    setStatus("#stream-status", `Offscreen stream restarted · ${streamInfo.state}`);
    recordLog("Restarted the offscreen capture stream; request its current live track again to test another clone cycle.", streamInfo);
  }));

  stopButton.addEventListener("click", () => guardedTask("Offscreen stream stop", async () => {
    if (streamInfo?.streamId === null || streamInfo?.streamId === undefined) throw new Error("Create an offscreen stream first.");
    streamInfo = await client.send("stream.stop", { streamId: streamInfo.streamId });
    renderState();
    setStatus("#stream-status", `Offscreen stream · ${streamInfo.state}`);
    recordLog("Stopped the offscreen track. Playback/source ownership remains independent.", streamInfo);
  }));

  disposeButton.addEventListener("click", () => guardedTask("Offscreen stream dispose", async () => {
    if (streamInfo?.streamId !== null && streamInfo?.streamId !== undefined) {
      streamInfo = await client.send("stream.dispose", { streamId: streamInfo.streamId });
    }
    if (mediaRecord !== null) {
      await client.send("media.remove", { mediaId: mediaRecord.id });
      mediaRecord = null;
    }
    stopTracks(receivedStream);
    receivedStream = null;
    preview.pause();
    preview.srcObject = null;
    displayTrack("#track-info", null);
    renderState();
    setStatus("#stream-status", "Offscreen stream and test media disposed");
    recordLog("Disposed the offscreen stream and removed its local source. The test bridge never stopped the original stream implicitly.");
    ingestButton.disabled = true;
    fileInput.value = "";
    selectedFile = null;
  }));

  refreshButton.addEventListener("click", () => guardedTask("Refresh offscreen state", refreshState));

  openConsumerButton.addEventListener("click", () => guardedTask("Open localhost consumer", async () => {
    if (typeof chrome === "undefined" || chrome.runtime?.id === undefined) throw new Error("Open this page from Chrome's loaded camera-test extension.");
    const url = new URL(consumerUrlInput.value);
    if (!(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) {
      throw new Error("The controlled consumer URL must use localhost, 127.0.0.1, or ::1; remote sites are not supported by this test.");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("The controlled consumer must use HTTP(S) localhost.");
    if (!url.pathname.endsWith("/tests/webrtc/web-consumer.html")) throw new Error("Use the local tests/webrtc/web-consumer.html page.");
    const extensionOrigin = window.location.origin;
    url.searchParams.set("openerOrigin", extensionOrigin);
    consumerOrigin = url.origin;
    consumerReady = false;
    pendingWebRequestId = null;
    consumerWindow = window.open(url.href, "capcam-phase06-local-consumer");
    if (consumerWindow === null) throw new Error("The browser blocked the localhost tab. Allow this explicit popup or open the local consumer manually.");
    setStatus("#consumer-status", `Waiting for page-world handshake from ${consumerOrigin}`);
    recordLog("Opened the explicitly controlled localhost consumer in a separate tab; no production site or content script is involved.", { url: url.href, extensionOrigin });
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
      if (pendingBridgeRequestId === null) return;
      recordLog("No response arrived from the offscreen BroadcastChannel probe. The bridge may be absent or MediaStream cloning may have failed.", { requestId: pendingBridgeRequestId });
      pendingBridgeRequestId = null;
      bridgeTimer = null;
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
      throw error;
    }
  }));

  window.addEventListener("message", (event: MessageEvent<unknown>) => {
    if (consumerWindow === null || consumerOrigin === null || event.origin !== consumerOrigin || event.source !== consumerWindow || !plainObject(event.data)) return;
    if (event.data.type === "capcam.local-consumer.ready") {
      consumerReady = true;
      setStatus("#consumer-status", `Page-world receiver ready · ${consumerOrigin}`);
      recordLog("The real localhost page-world consumer completed its opener-origin handshake.");
      renderState();
      if (receivedStream !== null) postReceivedStreamToConsumer();
      return;
    }
    if (event.data.type === "capcam.local-consumer.received" && event.data.requestId === pendingWebRequestId) {
      pendingWebRequestId = null;
      setStatus("#consumer-status", "Local page acknowledged the received stream");
      recordLog("Cross-origin test result reported by the localhost page itself.", event.data.result);
    }
  });

  window.addEventListener("pagehide", () => {
    if (bridgeTimer !== null) window.clearTimeout(bridgeTimer);
    channel?.close();
    stopTracks(receivedStream);
  });
}

function setupWebConsumer(): void {
  const requestCameraButton = element<HTMLButtonElement>("#request-camera");
  const startCameraCallButton = element<HTMLButtonElement>("#start-camera-call");
  const startOffscreenCallButton = element<HTMLButtonElement>("#start-offscreen-call");
  const replaceButton = element<HTMLButtonElement>("#replace-offscreen-track");
  const restoreButton = element<HTMLButtonElement>("#restore-camera-track");
  const closeCallButton = element<HTMLButtonElement>("#close-call");
  const cameraPreview = element<HTMLVideoElement>("#camera-preview");
  const offscreenPreview = element<HTMLVideoElement>("#offscreen-preview");
  const remotePreview = element<HTMLVideoElement>("#remote-preview");
  let openerOrigin: string | null = null;
  let cameraStream: MediaStream | null = null;
  let cameraTrack: MediaStreamTrack | null = null;
  let offscreenStream: MediaStream | null = null;
  let loopback: LoopbackSession | null = null;
  let videoSender: RTCRtpSender | null = null;
  let senderSource: "camera" | "offscreen" | null = null;

  try {
    const requestedOrigin = new URLSearchParams(window.location.search).get("openerOrigin");
    if (requestedOrigin === null || !requestedOrigin.startsWith("chrome-extension://") || new URL(requestedOrigin).origin !== requestedOrigin) {
      throw new Error("Missing or invalid extension opener origin. Open this page from the test extension button.");
    }
    openerOrigin = requestedOrigin;
  } catch (error) {
    setStatus("#consumer-status", errorText(error));
    recordLog("The localhost page refused to accept stream messages because the explicit extension origin is missing or invalid.", { error: errorText(error) });
    return;
  }

  const updateConsumerButtons = (): void => {
    startCameraCallButton.disabled = cameraStream === null || loopback !== null;
    startOffscreenCallButton.disabled = offscreenStream === null || loopback !== null;
    replaceButton.disabled = videoSender === null || offscreenStream === null || senderSource === "offscreen";
    restoreButton.disabled = videoSender === null || cameraTrack?.readyState !== "live" || senderSource !== "offscreen";
    closeCallButton.disabled = loopback === null;
  };

  requestCameraButton.addEventListener("click", () => guardedTask("Local page native camera", async () => {
    if (cameraStream !== null) throw new Error("The native local camera is already active.");
    const nativeGetUserMedia = navigator.mediaDevices?.getUserMedia;
    if (typeof nativeGetUserMedia !== "function") throw new Error("Native getUserMedia requires a secure local origin such as localhost.");
    recordLog("From this ordinary localhost page, calling native getUserMedia({ audio: false, video: true }); no method is patched.");
    cameraStream = await nativeGetUserMedia.call(navigator.mediaDevices, { audio: false, video: true });
    cameraTrack = cameraStream.getVideoTracks()[0] ?? null;
    if (cameraTrack === null) throw new Error("The browser returned no native video track.");
    cameraPreview.srcObject = cameraStream;
    await cameraPreview.play();
    displayTrack("#camera-track-info", cameraStream);
    setStatus("#consumer-status", "Native camera acquired in page world");
    recordLog("Page-visible native getUserMedia track.", trackSnapshot(cameraTrack));
    requestCameraButton.disabled = true;
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

  replaceButton.addEventListener("click", () => guardedTask("Replace page sender track", async () => {
    if (videoSender === null || offscreenStream === null) throw new Error("A connected sender and received offscreen stream are required.");
    const replacementTrack = offscreenStream.getVideoTracks()[0];
    if (replacementTrack === undefined) throw new Error("The received stream has no video track.");
    const previousTrack = videoSender.track;
    if (previousTrack?.kind !== "video") throw new Error("The active sender is not a video sender.");
    await videoSender.replaceTrack(replacementTrack);
    senderSource = "offscreen";
    const result = {
      previousTrack: trackSnapshot(previousTrack),
      requestedTrack: trackSnapshot(replacementTrack),
      senderNowUses: videoSender.track === null ? null : trackSnapshot(videoSender.track),
      senderTrackMatches: videoSender.track?.id === replacementTrack.id,
      signalingState: loopback?.senderPeer.signalingState ?? "closed",
      connectionState: loopback?.senderPeer.connectionState ?? "closed",
    };
    element<HTMLElement>("#sender-info").textContent = JSON.stringify(result, null, 2);
    setStatus("#consumer-status", "replaceTrack resolved · verify the remote video in this page");
    recordLog("The actual localhost page called RTCRtpSender.replaceTrack() with the received offscreen-generated video track.", result);
    updateConsumerButtons();
  }));

  restoreButton.addEventListener("click", () => guardedTask("Restore page camera track", async () => {
    if (videoSender === null || cameraTrack === null || cameraTrack.readyState !== "live") throw new Error("The original native camera track is no longer live.");
    const previousTrack = videoSender.track;
    await videoSender.replaceTrack(cameraTrack);
    senderSource = "camera";
    const result = { previousTrack: previousTrack === null ? null : trackSnapshot(previousTrack), senderNowUses: trackSnapshot(cameraTrack) };
    element<HTMLElement>("#sender-info").textContent = JSON.stringify(result, null, 2);
    setStatus("#consumer-status", "Sender restored to the native camera track");
    recordLog("The page restored its sender to the original native camera track.", result);
    updateConsumerButtons();
  }));

  const cleanup = (): void => {
    loopback?.close();
    loopback = null;
    videoSender = null;
    senderSource = null;
    stopTracks(cameraStream);
    stopTracks(offscreenStream);
    cameraStream = null;
    cameraTrack = null;
    offscreenStream = null;
    for (const video of [cameraPreview, offscreenPreview]) {
      video.pause();
      video.srcObject = null;
    }
    remotePreview.pause();
    remotePreview.srcObject = null;
    displayTrack("#camera-track-info", null);
    displayTrack("#offscreen-track-info", null);
    element<HTMLElement>("#sender-info").textContent = "No sender.";
    requestCameraButton.disabled = false;
    updateConsumerButtons();
    setStatus("#consumer-status", "Cleaned up local camera, received clone, and peer connections");
    recordLog("Page cleanup stopped its native and cloned tracks and closed both local peers.");
  };

  closeCallButton.addEventListener("click", cleanup);
  window.addEventListener("pagehide", cleanup);
  window.addEventListener("message", (event: MessageEvent<unknown>) => {
    if (openerOrigin === null || event.origin !== openerOrigin || event.source !== window.opener || !plainObject(event.data)) return;
    if (event.data.type !== "capcam.local-consumer.stream" || typeof event.data.requestId !== "string") return;
    const requestId = event.data.requestId;
    const stream = event.data.stream;
    if (!(stream instanceof MediaStream)) {
      const result = { accepted: false, displayStarted: false, isMediaStream: false, trackCount: 0, message: "Received value is not a MediaStream in the localhost page world." };
      window.opener?.postMessage({ type: "capcam.local-consumer.received", requestId, result }, openerOrigin);
      recordLog("The localhost page received a message but it did not contain a native MediaStream object.", result);
      return;
    }
    const tracks = stream.getTracks();
    offscreenStream = stream;
    offscreenPreview.srcObject = stream;
    displayTrack("#offscreen-track-info", stream);
    void offscreenPreview.play().then(() => {
      const result = {
        accepted: true,
        displayStarted: true,
        isMediaStream: true,
        streamId: stream.id,
        trackCount: tracks.length,
        tracks: tracks.map(trackSnapshot),
        receiverOrigin: window.location.origin,
      };
      setStatus("#consumer-status", "Offscreen stream received and displayed in the real localhost page");
      recordLog("The actual page-world JavaScript received and displayed the offscreen-generated track.", result);
      window.opener?.postMessage({ type: "capcam.local-consumer.received", requestId, result }, openerOrigin as string);
      startOffscreenCallButton.disabled = false;
      updateConsumerButtons();
    }).catch((error: unknown) => {
      const result = { accepted: true, displayStarted: false, isMediaStream: true, trackCount: tracks.length, error: errorText(error) };
      recordLog("A MediaStream reached the localhost page, but its video preview did not start.", result);
      window.opener?.postMessage({ type: "capcam.local-consumer.received", requestId, result }, openerOrigin as string);
      updateConsumerButtons();
    });
  });
  window.addEventListener("messageerror", () => {
    recordLog("The localhost page fired messageerror while deserializing the extension page's MediaStream message.");
    setStatus("#consumer-status", "MediaStream message deserialization error");
  });

  setStatus("#consumer-status", "Waiting for the extension page handshake");
  window.opener?.postMessage({ type: "capcam.local-consumer.ready" }, openerOrigin);
  recordLog("This normal localhost page is listening for a message from the exact extension-origin opener.", { openerOrigin, receiverOrigin: window.location.origin });
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
