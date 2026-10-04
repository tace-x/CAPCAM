import { describe, expect, it, vi } from "vitest";
import {
  createControlledTargetAgent,
  LocalCameraIntegrationAgent,
  LocalStreamProvider,
  type CameraSourceSelector,
} from "../../src/camera-integration/agent";
import { CameraIntegrationCore } from "../../src/camera-integration/camera-integration-core";
import type { CameraIntegration, CameraSource } from "../../src/camera-integration/camera-integration";
import type {
  CameraIntegrationStatus,
  CameraMediaStream,
  CameraVideoTrack,
  TargetLifecycleEvent,
  Unsubscribe,
} from "../../src/camera-integration/types";
import {
  WebRtcPeerConnectionRegistry,
  type WebRtcPeerConnectionPort,
  type WebRtcSenderPort,
} from "../../src/camera-integration/web-rtc-target-adapter";

function readyStatus(): CameraIntegrationStatus {
  return {
    state: "READY",
    origin: "https://call.example.test",
    supported: true,
    permission: "granted",
    capcamActive: false,
    originalTrackAvailable: true,
    activeTrackAvailable: false,
    reason: null,
  };
}

class FakeTrack implements CameraVideoTrack {
  readonly kind: string;
  readyState = "live";
  private readonly listeners = new Set<EventListener>();

  constructor(readonly id = "fake-track", kind = "video") {
    this.kind = kind;
  }

  addEventListener(_type: "ended", listener: EventListener): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: "ended", listener: EventListener): void {
    this.listeners.delete(listener);
  }

  end(): void {
    this.readyState = "ended";
    for (const listener of this.listeners) listener(new Event("ended"));
  }
}

class FakeStream implements CameraMediaStream {
  active = true;
  private readonly tracks: FakeTrack[];
  private readonly inactiveListeners = new Set<EventListener>();

  constructor(tracks: FakeTrack[]) {
    this.tracks = tracks;
  }

  getVideoTracks(): FakeTrack[] {
    return this.tracks.filter((track) => track.kind === "video");
  }

  addEventListener(_type: "inactive", listener: EventListener): void {
    this.inactiveListeners.add(listener);
  }

  removeEventListener(_type: "inactive", listener: EventListener): void {
    this.inactiveListeners.delete(listener);
  }

  end(): void {
    this.active = false;
    for (const listener of this.inactiveListeners) listener(new Event("inactive"));
  }
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
}

describe("local camera integration agent", () => {
  it("resolves selected media IDs locally and delegates replacement without serializing tracks", async () => {
    const track = new FakeTrack("med_12345678", "video") as unknown as CameraSource;
    const calls: CameraSource[] = [];
    const replaceTrack = async (source: CameraSource): Promise<CameraIntegrationStatus> => {
      calls.push(source);
      return { ...readyStatus(), state: "ACTIVE", capcamActive: true, activeTrackAvailable: true };
    };
    const integration = {
      getStatus: () => readyStatus(),
      replaceTrack,
    } as unknown as CameraIntegration;
    const select = vi.fn(async (mediaId: string) => mediaId === "med_12345678" ? track : null);
    const agent = new LocalCameraIntegrationAgent(integration, { select });

    const active = await agent.switchSource("med_12345678");
    expect(select).toHaveBeenCalledWith("med_12345678");
    expect(calls).toEqual([track]);
    expect(active.capcamActive).toBe(true);
  });

  it("reports a missing local source without calling replaceTrack", async () => {
    const replaceTrack = vi.fn(async (): Promise<CameraIntegrationStatus> => readyStatus());
    const integration = { getStatus: readyStatus, replaceTrack } as unknown as CameraIntegration;
    const selector: CameraSourceSelector = { select: async () => null };
    const agent = new LocalCameraIntegrationAgent(integration, selector);

    await expect(agent.switchSource("med_missing1")).resolves.toMatchObject({
      state: "READY",
      reason: "CAPCAM_SOURCE_UNAVAILABLE",
      capcamActive: false,
    });
    expect(replaceTrack).not.toHaveBeenCalled();
  });

  it("converts local source lookup failures into privacy-safe status without leaking the thrown error", async () => {
    const integration = { getStatus: readyStatus } as unknown as CameraIntegration;
    const agent = new LocalCameraIntegrationAgent(integration, {
      select: async () => { throw new Error("file path and media data must not be surfaced"); },
    });

    await expect(agent.switchSource("med_12345678")).resolves.toMatchObject({
      state: "READY",
      reason: "CAPCAM_SOURCE_SELECTION_FAILED",
      origin: "https://call.example.test",
    });
  });

  it("forwards lifecycle and status API calls to the local integration", async () => {
    const lifecycle: TargetLifecycleEvent[] = [];
    const listener = vi.fn();
    const unsubscribe = vi.fn();
    const integration = {
      getStatus: readyStatus,
      detect: async () => ({ ...readyStatus(), state: "READY" as const }),
      enable: async () => ({ ...readyStatus(), state: "ACTIVE" as const, capcamActive: true }),
      disable: async () => readyStatus(),
      replaceTrack: async () => readyStatus(),
      handleTargetLifecycle: async (event: TargetLifecycleEvent) => {
        lifecycle.push(event);
        return { ...readyStatus(), state: "BLOCKED" as const, reason: "PAGE_NAVIGATED" };
      },
      subscribeStatus: (callback: (status: CameraIntegrationStatus) => void): Unsubscribe => {
        callback(readyStatus());
        return unsubscribe;
      },
      destroy: async () => ({ ...readyStatus(), state: "IDLE" as const }),
    } as unknown as CameraIntegration;
    const agent = new LocalCameraIntegrationAgent(integration, { select: async () => null });

    agent.subscribeStatus(listener);
    expect(listener).toHaveBeenCalledWith(readyStatus());
    await expect(agent.handleTargetLifecycle("navigation")).resolves.toMatchObject({ reason: "PAGE_NAVIGATED" });
    await expect(agent.destroy()).resolves.toMatchObject({ state: "IDLE" });
    expect(lifecycle).toEqual(["navigation"]);
  });

  it("registers and unregisters controlled peer connections explicitly", () => {
    const registry = new WebRtcPeerConnectionRegistry();
    const integration = { getStatus: readyStatus } as unknown as CameraIntegrationCore;
    const agent = new LocalCameraIntegrationAgent(integration, undefined, registry);

    const sender = new FakeSender(new FakeTrack("cam", "video"));
    const peer = new FakePeerConnection([sender]);

    expect(agent.getPeerConnectionState()).toEqual({ isConnected: false, connectionCount: 0 });

    const unregister = agent.registerTarget(peer);
    expect(agent.getPeerConnectionState()).toEqual({ isConnected: true, connectionCount: 1 });

    unregister();
    expect(agent.getPeerConnectionState()).toEqual({ isConnected: false, connectionCount: 0 });

    agent.registerTarget(peer);
    expect(agent.getPeerConnectionState()).toEqual({ isConnected: true, connectionCount: 1 });

    agent.unregisterTarget(peer);
    expect(agent.getPeerConnectionState()).toEqual({ isConnected: false, connectionCount: 0 });
  });

  it("reports sender availability state without mutation", async () => {
    const registry = new WebRtcPeerConnectionRegistry();
    const nativeSender = new FakeSender(new FakeTrack("camera", "video"));
    const peer = new FakePeerConnection([nativeSender]);
    registry.register(peer);

    const agent = createControlledTargetAgent({
      origin: "https://call.example.test",
      connections: registry,
    });

    const senderState = await agent.getSenderState();
    expect(senderState).toEqual({
      available: true,
      isVideo: true,
      trackReadyState: "live",
    });
    expect(nativeSender.calls).toEqual([]);
  });
});

describe("controlled target end-to-end flow with createControlledTargetAgent", () => {
  const ORIGIN = "https://call.example.test";

  it("executes the full registration -> enable -> replaceTrack -> disable -> restore flow", async () => {
    const cameraTrack = new FakeTrack("camera-1", "video");
    const nativeSender = new FakeSender(cameraTrack);
    const peer = new FakePeerConnection([nativeSender]);

    const capcamTrack1 = new FakeTrack("capcam-img", "video");
    const capcamTrack2 = new FakeTrack("capcam-vid", "video");
    const streamProvider = new LocalStreamProvider(new FakeStream([capcamTrack1]));

    const agent = createControlledTargetAgent({
      origin: ORIGIN,
      streamProvider,
    });

    // 1. Initially detected, no connection registered
    const initialStatus = await agent.detect();
    expect(initialStatus.supported).toBe(false);
    expect(initialStatus.reason).toBe("NO_WEBRTC_CONNECTION");

    // 2. Explicitly register peer connection
    const unregisterPeer = agent.registerTarget(peer);
    const detected = await agent.detect();
    expect(detected.supported).toBe(true);
    expect(detected.state).toBe("READY");

    // 3. Enable camera replacement (Camera ON)
    const active = await agent.enable();
    expect(active.state).toBe("ACTIVE");
    expect(active.capcamActive).toBe(true);
    expect(nativeSender.track).toBe(capcamTrack1);
    expect(nativeSender.calls).toEqual([capcamTrack1]);

    // 4. Accept / switch to a second CapCam stream (image -> video switch)
    const switched = await agent.acceptSource(new FakeStream([capcamTrack2]));
    expect(switched.state).toBe("ACTIVE");
    expect(nativeSender.track).toBe(capcamTrack2);
    expect(nativeSender.calls).toEqual([capcamTrack1, capcamTrack2]);

    // 5. Disable camera replacement (Camera OFF) -> restores original camera track
    const disabled = await agent.disable();
    expect(disabled.state).toBe("READY");
    expect(disabled.capcamActive).toBe(false);
    expect(nativeSender.track).toBe(cameraTrack);
    expect(nativeSender.calls).toEqual([capcamTrack1, capcamTrack2, cameraTrack]);

    // 6. Cleanup
    unregisterPeer();
    const destroyed = await agent.destroy();
    expect(destroyed.state).toBe("IDLE");
  });

  it("handles repeated activation and restoration idempotently", async () => {
    const cameraTrack = new FakeTrack("camera-track", "video");
    const nativeSender = new FakeSender(cameraTrack);
    const peer = new FakePeerConnection([nativeSender]);
    const capcamTrack = new FakeTrack("capcam-track", "video");
    const streamProvider = new LocalStreamProvider(new FakeStream([capcamTrack]));

    const agent = createControlledTargetAgent({
      origin: ORIGIN,
      streamProvider,
    });
    agent.registerTarget(peer);

    // Repeated enable
    const firstEnable = await agent.enable();
    expect(firstEnable.state).toBe("ACTIVE");
    const secondEnable = await agent.enable();
    expect(secondEnable.state).toBe("ACTIVE");
    expect(nativeSender.calls).toEqual([capcamTrack]);

    // Repeated disable
    const firstDisable = await agent.disable();
    expect(firstDisable.state).toBe("READY");
    const secondDisable = await agent.disable();
    expect(secondDisable.state).toBe("READY");
    expect(nativeSender.calls).toEqual([capcamTrack, cameraTrack]);
    expect(nativeSender.track).toBe(cameraTrack);
  });

  it("recovers to the original track when the active CapCam track ends", async () => {
    const cameraTrack = new FakeTrack("camera-track", "video");
    const nativeSender = new FakeSender(cameraTrack);
    const peer = new FakePeerConnection([nativeSender]);
    const capcamTrack = new FakeTrack("capcam-track", "video");
    const streamProvider = new LocalStreamProvider(new FakeStream([capcamTrack]));

    const agent = createControlledTargetAgent({
      origin: ORIGIN,
      streamProvider,
    });
    agent.registerTarget(peer);
    await agent.enable();
    expect(nativeSender.track).toBe(capcamTrack);

    // CapCam source ends
    capcamTrack.end();
    const recovered = await agent.handleTrackEnded(capcamTrack);
    expect(recovered.state).toBe("READY");
    expect(recovered.capcamActive).toBe(false);
    expect(nativeSender.track).toBe(cameraTrack);
  });

  it("rejects ambiguous senders explicitly when multiple video senders exist", async () => {
    const firstSender = new FakeSender(new FakeTrack("v1", "video"));
    const secondSender = new FakeSender(new FakeTrack("v2", "video"));
    const peer = new FakePeerConnection([firstSender, secondSender]);

    const agent = createControlledTargetAgent({
      origin: ORIGIN,
      streamProvider: new LocalStreamProvider(new FakeStream([new FakeTrack("capcam", "video")])),
    });
    agent.registerTarget(peer);

    const detected = await agent.detect();
    expect(detected.supported).toBe(false);
    expect(detected.reason).toBe("AMBIGUOUS_VIDEO_SENDERS");

    const senderState = await agent.getSenderState();
    expect(senderState.available).toBe(false);
  });

  it("rejects invalid target origin upon creation", () => {
    expect(() => createControlledTargetAgent({ origin: "not-a-valid-origin" })).toThrow(/normalized exact HTTP\(S\) origin/);
  });

  it("handles permission denial and revocation safely", async () => {
    const cameraTrack = new FakeTrack("camera-track", "video");
    const nativeSender = new FakeSender(cameraTrack);
    const peer = new FakePeerConnection([nativeSender]);
    const capcamTrack = new FakeTrack("capcam-track", "video");

    let permState: "granted" | "required" = "required";
    let reqResult: "granted" | "denied" = "denied";
    const permissionBroker = {
      contains: vi.fn(async () => permState),
      request: vi.fn(async () => reqResult),
    };

    const agent = createControlledTargetAgent({
      origin: ORIGIN,
      streamProvider: new LocalStreamProvider(new FakeStream([capcamTrack])),
      permissionBroker,
    });
    agent.registerTarget(peer);
    await agent.detect();

    // Permission denied: cannot enable
    const status = await agent.enable();
    expect(status.state).toBe("BLOCKED");
    expect(status.reason).toBe("PERMISSION_DENIED");
    expect(nativeSender.calls).toEqual([]);

    // Now grant permission and enable
    permState = "granted";
    reqResult = "granted";
    const enabled = await agent.enable();
    expect(enabled.state).toBe("ACTIVE");
    expect(nativeSender.track).toBe(capcamTrack);

    // Permission revoked
    const revoked = await agent.handleTargetLifecycle("target-disconnected");
    expect(revoked.state).toBe("BLOCKED");
    expect(nativeSender.track).toBe(cameraTrack);
  });

  it("cleans up all connections and stream provider on destroy", async () => {
    const cameraTrack = new FakeTrack("camera-track", "video");
    const nativeSender = new FakeSender(cameraTrack);
    const peer = new FakePeerConnection([nativeSender]);
    const capcamTrack = new FakeTrack("capcam-track", "video");
    const streamProvider = new LocalStreamProvider(new FakeStream([capcamTrack]));

    const agent = createControlledTargetAgent({
      origin: ORIGIN,
      streamProvider,
    });
    agent.registerTarget(peer);
    await agent.enable();

    const destroyed = await agent.destroy();
    expect(destroyed.state).toBe("IDLE");
    expect(nativeSender.track).toBe(cameraTrack);
    expect(agent.getPeerConnectionState()).toEqual({ isConnected: false, connectionCount: 0 });
    expect(await streamProvider.getActiveStream()).toBeNull();
  });
});
