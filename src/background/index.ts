import { BackgroundMessageRouter } from "./message-router";
import { BackgroundRuntime } from "./runtime";
import { createChromeOffscreenPlatform, OffscreenManager } from "./offscreen-manager";
import { SettingsStorage } from "../storage/storage";
import { CapCamError, toCapCamError } from "../shared/errors";
import { createLogger } from "../shared/logger";
import { createErrorResponse, extractRequestId, isEventEnvelope } from "../messaging/protocol";
import { isTrustedOffscreenEvent } from "./event-relay";
import { generateRequestId } from "../messaging/commands";

const logger = createLogger("Runtime");
const extensionId = chrome.runtime.id;
const runtime = new BackgroundRuntime(
  new OffscreenManager(createChromeOffscreenPlatform()),
  new SettingsStorage(),
);
const cameraTestPageUrl = import.meta.env.MODE === "camera-test"
  ? chrome.runtime.getURL("tests/webrtc/offscreen-bridge.html")
  : null;
const messageRouter = new BackgroundMessageRouter(runtime, extensionId, chrome.runtime.getURL(""), {
  cameraTestPageUrl,
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (isEventEnvelope(message)) {
    if (isTrustedOffscreenEvent(message, sender, extensionId, chrome.runtime.getURL("public/offscreen.html"))) {
      void chrome.runtime.sendMessage(message).catch((error: unknown) => {
        logger.warn("An offscreen event could not be relayed to extension UI contexts.", { code: toCapCamError(error).code });
      });
    }
    return false;
  }
  void messageRouter.handle(message, sender).then(sendResponse).catch((error: unknown) => {
    const failure = toCapCamError(error);
    logger.error("Unexpected message listener failure.", { code: failure.code });
    const requestId = extractRequestId(message) ?? generateRequestId();
    sendResponse(createErrorResponse(requestId, new CapCamError("CAPCAM_RUNTIME_ERROR", "The runtime could not process the request.")));
  });
  return true;
});

chrome.runtime.onInstalled.addListener(() => {
  void runtime.initialize();
});

chrome.runtime.onStartup.addListener(() => {
  void runtime.initialize();
});

// Service workers can be restarted at any time; initialization is idempotent and discovers an existing document.
void runtime.initialize();
