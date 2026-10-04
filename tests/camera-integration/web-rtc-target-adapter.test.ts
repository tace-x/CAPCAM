import { describe, expect, it, vi } from "vitest";
import { GenericWebRtcTargetAdapter, WebRtcPeerConnectionRegistry, type WebRtcPeerConnectionPort, type WebRtcSenderPort } from "../../src/camera-integration/web-rtc-target-adapter";
import type { CameraVideoTrack } from "../../src/camera-integration/types";

const ORIGIN = "https://call.example.test";

class FakeTrack implements CameraVideoTrack {
  constructor(readonly kind = "video", public readyState = "live") {}
}

class FakeSender implements WebRtcSenderPort {
  readonly calls: Array<CameraVideoTrack | null> = [];

  constructor(public track: CameraVideoTrack | null) {}

  async replaceTrack(track: CameraVideoTrack | null): Promise<void> {
    this.calls.push(track);
    this.track = track;
  }
}

class FakePeerConnection implements WebRtcPeerConnectionPort {
  connectionState = "connected";
  private readonly listeners = new Map<string, Set<EventListener>>();

  constructor(private readonly senders: FakeSender[]) {}

  getSenders(): readonly FakeSender[] {
    return this.senders;
  }

  addEventListener(type: "connectionstatechange" | "signalingstatechange" | "negotiationneeded", listener: EventListener): void {
    const listeners = this.listeners.get(type) ?? new Set<EventListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: "connectionstatechange" | "signalingstatechange" | "negotiationneeded", listener: EventListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: "connectionstatechange" | "signalingstatechange" | "negotiationneeded"): void {
    for (const listener of this.listeners.get(type) ?? []) listener(new Event(type));
  }

  removeSender(sender: FakeSender): void {
    const index = this.senders.indexOf(sender);
    if (index >= 0) this.senders.splice(index, 1);
    this.emit("negotiationneeded");
  }
}

describe("generic WebRTC target adapter", () => {
  it("discovers exactly one live video sender and ignores audio senders", async () => {
    const videoSender = new FakeSender(new FakeTrack());
    const audioSender = new FakeSender(new FakeTrack("audio"));
    const peerConnection = new FakePeerConnection([audioSender, videoSender]);
    const registry = new WebRtcPeerConnectionRegistry();
    registry.register(peerConnection);
    const adapter = new GenericWebRtcTargetAdapter(ORIGIN, registry);

    expect(await adapter.detect(ORIGIN)).toMatchObject({
      supported: true,
      hasWebRtcWorkflow: true,
      hasCameraWorkflow: true,
    });
    const first = await adapter.findVideoSender();
    const second = await adapter.findVideoSender();
    expect(first).not.toBeNull();
    expect(second).toBe(first);
    expect(first?.track).toBe(videoSender.track);
    expect(adapter.isSenderAvailable(first!)).toBe(true);
    expect(audioSender.calls).toEqual([]);
  });

  it("reports an ambiguous supported context as unsupported instead of guessing a sender", async () => {
    const first = new FakeSender(new FakeTrack());
    const second = new FakeSender(new FakeTrack());
    const registry = new WebRtcPeerConnectionRegistry();
    registry.register(new FakePeerConnection([first, second]));
    const adapter = new GenericWebRtcTargetAdapter(ORIGIN, registry);

    expect(await adapter.detect(ORIGIN)).toMatchObject({
      supported: false,
      hasWebRtcWorkflow: true,
      hasCameraWorkflow: true,
      reasonCode: "AMBIGUOUS_VIDEO_SENDERS",
    });
    await expect(adapter.findVideoSender()).rejects.toMatchObject({ code: "AMBIGUOUS_VIDEO_SENDERS" });
  });

  it("replaces and restores the same native sender without stopping either track", async () => {
    const original = new FakeTrack();
    const capcam = new FakeTrack();
    const nativeSender = new FakeSender(original);
    const registry = new WebRtcPeerConnectionRegistry();
    registry.register(new FakePeerConnection([nativeSender]));
    const adapter = new GenericWebRtcTargetAdapter(ORIGIN, registry);
    const sender = await adapter.findVideoSender();
    expect(sender).not.toBeNull();

    await adapter.replaceVideoTrack(sender!, capcam);
    expect(nativeSender.track).toBe(capcam);
    await adapter.restoreVideoTrack(sender!, original);
    expect(nativeSender.track).toBe(original);
    expect(original.readyState).toBe("live");
    expect(capcam.readyState).toBe("live");
    expect(nativeSender.calls).toEqual([capcam, original]);
  });

  it("detects a disappeared sender and does not call its stale replaceTrack method", async () => {
    const nativeSender = new FakeSender(new FakeTrack());
    const connection = new FakePeerConnection([nativeSender]);
    const registry = new WebRtcPeerConnectionRegistry();
    registry.register(connection);
    const adapter = new GenericWebRtcTargetAdapter(ORIGIN, registry);
    const sender = await adapter.findVideoSender();
    connection.removeSender(nativeSender);

    expect(adapter.isSenderAvailable(sender!)).toBe(false);
    await expect(adapter.replaceVideoTrack(sender!, new FakeTrack())).rejects.toThrow(/disappeared/);
    expect(nativeSender.calls).toEqual([]);
  });

  it("keeps transient disconnections reconnectable and expires only after the grace window", () => {
    vi.useFakeTimers();
    try {
      const connection = new FakePeerConnection([new FakeSender(new FakeTrack())]);
      const registry = new WebRtcPeerConnectionRegistry(1800);
      const states: boolean[] = [];
      registry.subscribe(() => states.push(registry.isConnected()));
      registry.register(connection);

      connection.connectionState = "disconnected";
      connection.emit("connectionstatechange");
      vi.advanceTimersByTime(1799);
      expect(registry.isConnected()).toBe(true);
      connection.connectionState = "connected";
      connection.emit("connectionstatechange");
      vi.advanceTimersByTime(1800);
      expect(registry.isConnected()).toBe(true);

      connection.connectionState = "disconnected";
      connection.emit("connectionstatechange");
      vi.advanceTimersByTime(1800);
      expect(registry.isConnected()).toBe(false);
      expect(states).toContain(false);

      connection.connectionState = "connected";
      connection.emit("connectionstatechange");
      expect(registry.isConnected()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects foreign origins and closed connections without calling a sender", async () => {
    const nativeSender = new FakeSender(new FakeTrack());
    const connection = new FakePeerConnection([nativeSender]);
    const registry = new WebRtcPeerConnectionRegistry();
    registry.register(connection);
    const adapter = new GenericWebRtcTargetAdapter(ORIGIN, registry);

    expect(await adapter.detect("https://other.example.test")).toMatchObject({
      supported: false,
      reasonCode: "UNSUPPORTED_ORIGIN",
    });
    connection.connectionState = "closed";
    connection.emit("connectionstatechange");
    expect(await adapter.detect(ORIGIN)).toMatchObject({
      supported: false,
      reasonCode: "NO_WEBRTC_CONNECTION",
    });
    expect(vi.isMockFunction(nativeSender.replaceTrack)).toBe(false);
  });
});
