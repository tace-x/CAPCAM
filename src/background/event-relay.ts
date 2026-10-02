import { isEventEnvelope } from "../messaging/protocol";
import type { EventEnvelope } from "../messaging/events";

export interface EventSender {
  id?: string | undefined;
  url?: string | undefined;
}

export function isTrustedOffscreenEvent(
  message: unknown,
  sender: EventSender,
  extensionId: string,
  offscreenUrl: string,
): message is EventEnvelope {
  return isEventEnvelope(message) && sender.id === extensionId && sender.url === offscreenUrl;
}
