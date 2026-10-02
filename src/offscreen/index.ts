import { CommandRouter } from "../messaging/router";
import { createErrorResponse, extractRequestId } from "../messaging/protocol";
import { generateRequestId } from "../messaging/commands";
import { CapCamError, toCapCamError } from "../shared/errors";
import { createLogger } from "../shared/logger";
import { MediaRuntime } from "./media-runtime";
import { OffscreenRuntime } from "./runtime";

const logger = createLogger("Offscreen");
const runtime = new OffscreenRuntime(new MediaRuntime());
const router = new CommandRouter();
router.register("offscreen.initialize", () => runtime.initialize());
router.register("offscreen.getStatus", () => runtime.getStatus());
router.register("offscreen.shutdown", () => runtime.shutdown());

function isServiceWorkerSender(sender: chrome.runtime.MessageSender): boolean {
  return sender.id === chrome.runtime.id && sender.url === chrome.runtime.getURL("background.js");
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!isServiceWorkerSender(sender)) return false;
  void router.handle(message).then(sendResponse).catch((error: unknown) => {
    const failure = toCapCamError(error);
    logger.error("Unexpected offscreen command listener failure.", { code: failure.code });
    const requestId = extractRequestId(message) ?? generateRequestId();
    sendResponse(createErrorResponse(requestId, new CapCamError("CAPCAM_RUNTIME_ERROR", "The offscreen runtime could not process the request.")));
  });
  return true;
});

// The document is safe to recreate; initialization is idempotent if the worker also requests it.
void runtime.initialize().catch((error: unknown) => {
  logger.error("Offscreen startup failed.", { code: toCapCamError(error).code });
});
