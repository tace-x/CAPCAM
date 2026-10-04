import { CommandRouter } from "../messaging/router";
import { OFFSCREEN_STREAM_BRIDGE_CHANNEL, OFFSCREEN_STREAM_BRIDGE_PROTOCOL, isOffscreenStreamBridgeRequest } from "../shared/camera-test-bridge";
import { createErrorResponse, extractRequestId, isEventEnvelope } from "../messaging/protocol";
import { generateRequestId } from "../messaging/commands";
import { CapCamError, toCapCamError } from "../shared/errors";
import { createLogger } from "../shared/logger";
import { MediaEngine } from "../media/media-engine";
import { IndexedDbMediaTransferStore } from "../media/media-transfer-store";
import { MediaRuntime } from "./media-runtime";
import { RuntimeManager } from "./runtime-manager";
import { CanvasStreamPipelineFactory } from "../stream/canvas-stream-pipeline";
import { StreamManager } from "../stream/stream-manager";
import { PlaybackEngine } from "../playback/playback-engine";
import type { EventEnvelope } from "../messaging/events";

const logger = createLogger("Offscreen");
let runtime: RuntimeManager | null = null;

const publishEvent = (event: EventEnvelope): void => {
  void chrome.runtime.sendMessage(event).catch((error: unknown) => {
    logger.warn("An offscreen event could not reach the service worker.", { code: toCapCamError(error).code });
  });
  if (event.type === "stream.stateChanged" ||
    (event.type.startsWith("playback.") && event.type !== "playback.timeupdate" && event.type !== "playback.loading" && event.type !== "playback.loaded" && event.type !== "playback.seek" && event.type !== "playback.loop" && event.type !== "playback.loopchange" && event.type !== "playback.ratechange")) {
    runtime?.observeSubsystemActivity();
  }
};

const engine = new MediaEngine({
  transferStore: new IndexedDbMediaTransferStore(),
  publishEvent,
});
const pipelineFactory = new CanvasStreamPipelineFactory(engine);
const streams = new StreamManager(pipelineFactory, { publishEvent });
const playback = new PlaybackEngine(engine, { publishEvent });
const mediaRuntime = new MediaRuntime(engine, streams, playback);
const manager = new RuntimeManager(mediaRuntime, { publishEvent });
runtime = manager;
const runSubsystem = <T>(operation: () => T | Promise<T>): Promise<T> => manager.runSubsystemOperation(operation);
const router = new CommandRouter({
  authorize: (command) => manager.authorizeCommand(command.type, command.runtimeSessionId),
  getRuntimeSessionId: () => manager.getState().runtimeSessionId,
});

router.register("runtime.initialize", () => manager.initialize());
router.register("runtime.shutdown", () => manager.shutdown());
router.register("runtime.reset", () => manager.reset());
router.register("runtime.getState", () => manager.getState());
router.register("runtime.getDiagnostics", () => manager.getDiagnostics());
router.register("runtime.ping", () => manager.ping());
router.register("offscreen.initialize", async () => {
  await manager.initialize();
  return manager.getOffscreenStatus();
});
router.register("offscreen.getStatus", () => manager.getOffscreenStatus());
router.register("offscreen.shutdown", async () => {
  await manager.shutdown();
  return manager.getOffscreenStatus();
});
router.register("media.register", (payload) => runSubsystem(() => mediaRuntime.register(payload)));
router.register("media.get", (payload) => runSubsystem(() => mediaRuntime.get(payload)));
router.register("media.list", () => runSubsystem(() => mediaRuntime.list()));
router.register("media.remove", (payload) => runSubsystem(() => mediaRuntime.remove(payload)));
router.register("media.clear", () => runSubsystem(() => mediaRuntime.clear()));
router.register("media.inspect", (payload) => runSubsystem(() => mediaRuntime.inspect(payload)));
router.register("stream.create", (payload) => runSubsystem(() => mediaRuntime.createStream(payload)));
router.register("stream.getState", () => runSubsystem(() => mediaRuntime.getStreamState()));
router.register("stream.start", (payload) => runSubsystem(() => mediaRuntime.startStream(payload)));
router.register("stream.stop", (payload) => runSubsystem(() => mediaRuntime.stopStream(payload)));
router.register("stream.restart", (payload) => runSubsystem(() => mediaRuntime.restartStream(payload)));
router.register("stream.switchSource", (payload) => runSubsystem(() => mediaRuntime.switchStreamSource(payload)));
router.register("stream.getTrackInfo", (payload) => runSubsystem(() => mediaRuntime.getStreamTrackInfo(payload)));
router.register("stream.dispose", (payload) => runSubsystem(() => mediaRuntime.disposeStream(payload)));
router.register("playback.load", (payload) => runSubsystem(() => mediaRuntime.loadPlayback(payload)));
router.register("playback.play", (payload) => runSubsystem(() => mediaRuntime.playPlayback(payload)));
router.register("playback.pause", (payload) => runSubsystem(() => mediaRuntime.pausePlayback(payload)));
router.register("playback.stop", (payload) => runSubsystem(() => mediaRuntime.stopPlayback(payload)));
router.register("playback.restart", (payload) => runSubsystem(() => mediaRuntime.restartPlayback(payload)));
router.register("playback.seek", (payload) => runSubsystem(() => mediaRuntime.seekPlayback(payload)));
router.register("playback.setLoop", (payload) => runSubsystem(() => mediaRuntime.setPlaybackLoop(payload)));
router.register("playback.setRate", (payload) => runSubsystem(() => mediaRuntime.setPlaybackRate(payload)));
router.register("playback.getState", () => runSubsystem(() => mediaRuntime.getPlaybackState()));
router.register("playback.dispose", (payload) => runSubsystem(() => mediaRuntime.disposePlayback(payload)));

function isAuthorizedCommandSender(sender: chrome.runtime.MessageSender): boolean {
  return sender.id === chrome.runtime.id && sender.tab === undefined;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!isAuthorizedCommandSender(sender) || isEventEnvelope(message)) return false;
  void router.handle(message).then(sendResponse).catch((error: unknown) => {
    const failure = toCapCamError(error);
    logger.error("Unexpected offscreen command listener failure.", { code: failure.code });
    const requestId = extractRequestId(message) ?? generateRequestId();
    sendResponse(createErrorResponse(requestId, new CapCamError("CAPCAM_RUNTIME_ERROR", "The offscreen runtime could not process the request."), runtime?.getState().runtimeSessionId));
  });
  return true;
});

function installCameraTestStreamBridge(): void {
  let channel: BroadcastChannel;
  try {
    channel = new BroadcastChannel(OFFSCREEN_STREAM_BRIDGE_CHANNEL);
  } catch (error) {
    logger.warn("Phase 06 test bridge could not open its BroadcastChannel.", { reason: error instanceof Error ? error.message : "Unknown channel error." });
    return;
  }

  const postError = (requestId: string, error: unknown): void => {
    try {
      channel.postMessage({
        protocol: OFFSCREEN_STREAM_BRIDGE_PROTOCOL,
        type: "error",
        requestId,
        message: error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 400) : "The active offscreen stream is unavailable.",
      });
    } catch {
      logger.warn("Phase 06 test bridge could not report an error response.");
    }
  };

  channel.addEventListener("message", (event: MessageEvent<unknown>) => {
    if (!isOffscreenStreamBridgeRequest(event.data)) return;
    const { requestId } = event.data;
    void runSubsystem(() => streams.getStream()).then((stream) => {
      try {
        // Native structured cloning over BroadcastChannel is the behavior under test.
        // This never travels through chrome.runtime messaging or serializes raw frames.
        channel.postMessage({
          protocol: OFFSCREEN_STREAM_BRIDGE_PROTOCOL,
          type: "active-stream",
          requestId,
          stream,
        });
      } catch (error) {
        postError(requestId, error);
      }
    }).catch((error: unknown) => postError(requestId, error));
  });

  window.addEventListener("pagehide", () => channel.close(), { once: true });
  logger.info("Phase 06 test-only offscreen BroadcastChannel bridge is active.");
}

if (import.meta.env.MODE === "camera-test") installCameraTestStreamBridge();

// The document is safe to recreate; module initialization is idempotent and session IDs distinguish new instances.
void manager.initialize().catch((error: unknown) => {
  logger.error("Offscreen startup failed.", { code: toCapCamError(error).code });
});
