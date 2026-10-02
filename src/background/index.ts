import { BackgroundMessageRouter } from "./message-router";
import { BackgroundRuntime } from "./runtime";
import { createChromeOffscreenPlatform, OffscreenManager } from "./offscreen-manager";
import { SettingsStorage } from "../storage/storage";
import { CapCamError, toCapCamError } from "../shared/errors";
import { createLogger } from "../shared/logger";
import { createErrorResponse, extractRequestId } from "../messaging/protocol";
import { generateRequestId } from "../messaging/commands";

const logger = createLogger("Runtime");
const extensionId = chrome.runtime.id;
const runtime = new BackgroundRuntime(
  new OffscreenManager(createChromeOffscreenPlatform()),
  new SettingsStorage(),
);
const messageRouter = new BackgroundMessageRouter(runtime, extensionId, chrome.runtime.getURL(""));

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
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
