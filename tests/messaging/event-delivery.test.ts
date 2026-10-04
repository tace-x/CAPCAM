import { describe, expect, it } from "vitest";
import { isTrustedOffscreenEvent } from "../../src/background/event-relay";
import { createEvent, type EventEnvelope } from "../../src/messaging/events";
import { MessagingClient, type RuntimeEventListener, type RuntimeEventSender, type RuntimeEventSource } from "../../src/messaging/client";

class FakeRuntimeEventSource implements RuntimeEventSource {
  readonly extensionId = "capcam-extension";
  readonly backgroundUrl = "chrome-extension://capcam-extension/background.js";
  readonly listeners = new Set<RuntimeEventListener>();

  addListener(listener: RuntimeEventListener): void {
    this.listeners.add(listener);
  }

  removeListener(listener: RuntimeEventListener): void {
    this.listeners.delete(listener);
  }

  emit(message: unknown, sender: RuntimeEventSender): void {
    for (const listener of this.listeners) listener(message, sender);
  }
}

const removedEvent = createEvent("media.removed", { mediaId: "med_fixture0001" });
const cameraStatusEvent = createEvent("camera.statusChanged", {
  revision: 1,
  changedAt: 1234,
  status: {
    state: "BLOCKED_PHASE_06_VERIFICATION",
    origin: null,
    supported: false,
    permission: "unavailable",
    capcamActive: false,
    originalTrackAvailable: false,
    activeTrackAvailable: false,
    reason: "BLOCKED_PHASE_06_VERIFICATION",
  },
});

describe("offscreen event relay and popup subscription", () => {
  it("only trusts validated events sent by this extension's exact offscreen document", () => {
    const offscreenUrl = "chrome-extension://capcam-extension/public/offscreen.html";
    expect(isTrustedOffscreenEvent(removedEvent, { id: "capcam-extension", url: offscreenUrl }, "capcam-extension", offscreenUrl)).toBe(true);
    expect(isTrustedOffscreenEvent(removedEvent, { id: "capcam-extension", url: "chrome-extension://capcam-extension/popup.html" }, "capcam-extension", offscreenUrl)).toBe(false);
    expect(isTrustedOffscreenEvent(removedEvent, { id: "another-extension", url: offscreenUrl }, "capcam-extension", offscreenUrl)).toBe(false);
    expect(isTrustedOffscreenEvent({ ...removedEvent, payload: { mediaId: "bad" } }, { id: "capcam-extension", url: offscreenUrl }, "capcam-extension", offscreenUrl)).toBe(false);
  });

  it("subscribes only to valid background broadcasts and removes its listener", () => {
    const source = new FakeRuntimeEventSource();
    const client = new MessagingClient({ sendMessage: async () => undefined }, source);
    const received: EventEnvelope[] = [];
    const unsubscribe = client.subscribeEvents((event) => received.push(event));

    source.emit(removedEvent, { id: "capcam-extension", url: source.backgroundUrl });
    source.emit(cameraStatusEvent, { id: "capcam-extension", url: source.backgroundUrl });
    source.emit(removedEvent, { id: "another-extension", url: source.backgroundUrl });
    source.emit(removedEvent, { id: "capcam-extension", url: "chrome-extension://capcam-extension/offscreen.html" });
    source.emit({ ...removedEvent, payload: { mediaId: "bad" } }, { id: "capcam-extension", url: source.backgroundUrl });

    expect(received).toEqual([removedEvent, cameraStatusEvent]);
    unsubscribe();
    source.emit(removedEvent, { id: "capcam-extension", url: source.backgroundUrl });
    expect(received).toHaveLength(2);
    expect(source.listeners.size).toBe(0);
  });
});
