import { CommandRouter } from "../messaging/router";
import { createErrorResponse, extractRequestId, isEventEnvelope } from "../messaging/protocol";
import { generateRequestId } from "../messaging/commands";
import { CapCamError, toCapCamError } from "../shared/errors";
import { createLogger } from "../shared/logger";
import { MediaEngine } from "../media/media-engine";
import { IndexedDbMediaTransferStore } from "../media/media-transfer-store";
import { MediaRuntime } from "./media-runtime";
import { OffscreenRuntime } from "./runtime";

const logger = createLogger("Offscreen");
const engine = new MediaEngine({
  transferStore: new IndexedDbMediaTransferStore(),
  publishEvent: (event) => {
    void chrome.runtime.sendMessage(event).catch((error: unknown) => {
      logger.warn("Media event could not reach the service worker.", { code: toCapCamError(error).code });
    });
  },
});
const mediaRuntime = new MediaRuntime(engine);
const runtime = new OffscreenRuntime(mediaRuntime);
const router = new CommandRouter();
router.register("offscreen.initialize", () => runtime.initialize());
router.register("offscreen.getStatus", () => runtime.getStatus());
router.register("offscreen.shutdown", () => runtime.shutdown());
router.register("media.register", (payload) => mediaRuntime.register(payload));
router.register("media.get", (payload) => mediaRuntime.get(payload));
router.register("media.list", () => mediaRuntime.list());
router.register("media.remove", (payload) => mediaRuntime.remove(payload));
router.register("media.clear", () => mediaRuntime.clear());
router.register("media.inspect", (payload) => mediaRuntime.inspect(payload));

function isServiceWorkerSender(sender: chrome.runtime.MessageSender): boolean {
  return sender.id === chrome.runtime.id && sender.url === chrome.runtime.getURL("background.js");
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!isServiceWorkerSender(sender) || isEventEnvelope(message)) return false;
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
