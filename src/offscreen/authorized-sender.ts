export interface OffscreenMessageSenderLike {
  id?: string | undefined;
  url?: string | undefined;
  tab?: unknown | undefined;
}

/**
 * Determines whether a message sender is authorized to issue commands directly to the offscreen runtime.
 *
 * In CapCam's MV3 architecture:
 * Popup / Extension UI -> Background Message Router -> OffscreenManager -> Offscreen Runtime.
 *
 * Offscreen commands must originate exclusively from the background service worker.
 * Extension UI pages (such as popup.html or developer-test.html) communicate with Background,
 * which enforces lifecycle readiness, settings, and authoritative session management.
 *
 * In Chrome MV3, service worker senders have `tab === undefined` and `url === undefined`
 * (or the extension's backgroundUrl in mock test harnesses). Extension UI pages have `typeof url === "string"`
 * pointing to their respective HTML documents.
 */
export function isAuthorizedOffscreenCommandSender(
  sender: OffscreenMessageSenderLike,
  extensionId: string,
  backgroundUrl?: string,
): boolean {
  if (sender.id !== extensionId || sender.tab !== undefined) {
    return false;
  }
  if (typeof sender.url === "string" && (backgroundUrl === undefined || sender.url !== backgroundUrl)) {
    return false;
  }
  return true;
}
