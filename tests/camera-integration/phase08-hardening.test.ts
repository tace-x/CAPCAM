import { describe, expect, it } from "vitest";
import {
  createControlledTargetAgent,
  LocalStreamProvider,
  type CameraSourceSelector,
} from "../../src/camera-integration/agent";
import type {
  CameraIntegrationDiagnostic,
  CameraMediaStream,
  CameraVideoTrack,
} from "../../src/camera-integration/types";
import type {
  WebRtcPeerConnectionPort,
  WebRtcSenderPort,
} from "../../src/camera-integration/web-rtc-target-adapter";

const ORIGIN = "https://call.example.test";

class TrackSpy implements CameraVideoTrack {
  readonly kind: string;
  readyState = "live";
  stopCallCount = 0;
  private readonly listeners = new Set<EventListener>();

  constructor(readonly id = "track-spy", kind = "video") {
    this.kind = kind;
  }

  addEventListener(_type: "ended", listener: EventListener): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: "ended", listener: EventListener): void {
    this.listeners.delete(listener);
  }

  stop(): void {
    this.stopCallCount += 1;
    this.readyState = "ended";
    for (const listener of this.listeners) listener(new Event("ended"));
  }

  end(): void {
    this.readyState = "ended";
    for (const listener of this.listeners) listener(new Event("ended"));
  }
}

class StreamSpy implements CameraMediaStream {
  active = true;
  private readonly tracks: TrackSpy[];
  private readonly inactiveListeners = new Set<EventListener>();

  constructor(tracks: TrackSpy[]) {
    this.tracks = tracks;
  }

  getVideoTracks(): TrackSpy[] {
    return this.tracks.filter((t) => t.kind === "video");
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

class SenderSpy implements WebRtcSenderPort {
  readonly calls: Array<CameraVideoTrack | null> = [];
  shouldFailNext = false;
  failAfterMutation = false;

  constructor(public track: CameraVideoTrack | null) {}

  async replaceTrack(track: CameraVideoTrack | null): Promise<void> {
    this.calls.push(track);
    if (this.shouldFailNext) {
      this.shouldFailNext = false;
      throw new Error("Simulated sender failure");
    }
    this.track = track;
    if (this.failAfterMutation) {
      this.failAfterMutation = false;
      throw new Error("Simulated sender failure after mutation");
    }
  }
}

class PeerConnectionSpy implements WebRtcPeerConnectionPort {
  connectionState = "connected";
  private readonly listeners = new Map<string, Set<EventListener>>();

  constructor(private readonly senders: SenderSpy[]) {}

  getSenders(): readonly SenderSpy[] {
    return this.senders;
  }

  addEventListener(type: "connectionstatechange" | "signalingstatechange" | "negotiationneeded", listener: EventListener): void {
    const list = this.listeners.get(type) ?? new Set<EventListener>();
    list.add(listener);
    this.listeners.set(type, list);
  }

  removeEventListener(type: "connectionstatechange" | "signalingstatechange" | "negotiationneeded", listener: EventListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  close(): void {
    this.connectionState = "closed";
    for (const listener of this.listeners.get("connectionstatechange") ?? []) {
      listener(new Event("connectionstatechange"));
    }
  }
}

describe("Phase 08: Camera integration hardening & runtime handoff", () => {
  describe("1. Track ownership invariants", () => {
    it("never calls .stop() on the target's original camera track during enable, replace, disable, or destroy", async () => {
      const originalTrack = new TrackSpy("native-cam", "video");
      const sender = new SenderSpy(originalTrack);
      const peer = new PeerConnectionSpy([sender]);

      const capcamTrack1 = new TrackSpy("capcam-img-1", "video");
      const capcamTrack2 = new TrackSpy("capcam-vid-2", "video");
      const streamProvider = new LocalStreamProvider(new StreamSpy([capcamTrack1]));

      const agent = createControlledTargetAgent({
        origin: ORIGIN,
        streamProvider,
      });
      agent.registerTarget(peer);

      // Enable (Camera ON)
      await agent.enable();
      expect(sender.track).toBe(capcamTrack1);
      expect(originalTrack.stopCallCount).toBe(0);
      expect(originalTrack.readyState).toBe("live");

      // Replace source (image -> video)
      await agent.acceptSource(new StreamSpy([capcamTrack2]));
      expect(sender.track).toBe(capcamTrack2);
      expect(originalTrack.stopCallCount).toBe(0);
      expect(originalTrack.readyState).toBe("live");

      // Disable (Camera OFF) -> restores original track
      await agent.disable();
      expect(sender.track).toBe(originalTrack);
      expect(originalTrack.stopCallCount).toBe(0);
      expect(originalTrack.readyState).toBe("live");

      // Destroy
      await agent.destroy();
      expect(originalTrack.stopCallCount).toBe(0);
      expect(originalTrack.readyState).toBe("live");
    });
  });

  describe("2. Source switching across all combinations with rollback on failure", () => {
    it("handles image -> video -> video -> image transitions seamlessly on the same sender", async () => {
      const originalTrack = new TrackSpy("original-camera", "video");
      const sender = new SenderSpy(originalTrack);
      const peer = new PeerConnectionSpy([sender]);

      const imageTrackA = new TrackSpy("img-A", "video");
      const videoTrackB = new TrackSpy("vid-B", "video");
      const videoTrackC = new TrackSpy("vid-C", "video");
      const imageTrackD = new TrackSpy("img-D", "video");

      const selector: CameraSourceSelector = {
        select: async (id: string) => {
          if (id === "img-A") return new StreamSpy([imageTrackA]);
          if (id === "vid-B") return new StreamSpy([videoTrackB]);
          if (id === "vid-C") return new StreamSpy([videoTrackC]);
          if (id === "img-D") return new StreamSpy([imageTrackD]);
          return null;
        },
      };

      const streamProvider = new LocalStreamProvider(new StreamSpy([imageTrackA]));
      const agent = createControlledTargetAgent({
        origin: ORIGIN,
        streamProvider,
        sources: selector,
      });
      agent.registerTarget(peer);

      // 1. Initial Enable with image A
      await agent.enable();
      expect(sender.track).toBe(imageTrackA);

      // 2. image -> video (switch to B)
      const resB = await agent.switchSource("vid-B");
      expect(resB.capcamActive).toBe(true);
      expect(sender.track).toBe(videoTrackB);

      // 3. video -> video (switch to C)
      const resC = await agent.switchSource("vid-C");
      expect(resC.capcamActive).toBe(true);
      expect(sender.track).toBe(videoTrackC);

      // 4. video -> image (switch to D)
      const resD = await agent.switchSource("img-D");
      expect(resD.capcamActive).toBe(true);
      expect(sender.track).toBe(imageTrackD);

      // 5. image -> image (switch back to A)
      const resA = await agent.switchSource("img-A");
      expect(resA.capcamActive).toBe(true);
      expect(sender.track).toBe(imageTrackA);

      // 6. Disable cleanly restores original track
      await agent.disable();
      expect(sender.track).toBe(originalTrack);
      expect(originalTrack.stopCallCount).toBe(0);
    });

    it("rolls back to previous valid CapCam track when new source replacement throws", async () => {
      const originalTrack = new TrackSpy("original-camera", "video");
      const sender = new SenderSpy(originalTrack);
      const peer = new PeerConnectionSpy([sender]);

      const trackA = new TrackSpy("valid-track-A", "video");
      const trackB = new TrackSpy("faulty-track-B", "video");

      const streamProvider = new LocalStreamProvider(new StreamSpy([trackA]));
      const agent = createControlledTargetAgent({
        origin: ORIGIN,
        streamProvider,
      });
      agent.registerTarget(peer);
      await agent.enable();
      expect(sender.track).toBe(trackA);

      // Configure sender to fail next replacement
      sender.shouldFailNext = true;

      const failedSwitch = await agent.replaceTrack(new StreamSpy([trackB]));
      expect(failedSwitch.reason).toBe("TRACK_REPLACEMENT_FAILED");
      // Sender rolled back to trackA
      expect(sender.track).toBe(trackA);
      expect(failedSwitch.capcamActive).toBe(true);
    });

    it("preserves active state when non-existent source is requested without modifying sender", async () => {
      const originalTrack = new TrackSpy("original-camera", "video");
      const sender = new SenderSpy(originalTrack);
      const peer = new PeerConnectionSpy([sender]);
      const trackA = new TrackSpy("active-track-A", "video");

      const streamProvider = new LocalStreamProvider(new StreamSpy([trackA]));
      const selector: CameraSourceSelector = {
        select: async (id: string) => id === "good" ? new StreamSpy([trackA]) : null,
      };

      const agent = createControlledTargetAgent({
        origin: ORIGIN,
        streamProvider,
        sources: selector,
      });
      agent.registerTarget(peer);
      await agent.enable();

      const callCountBefore = sender.calls.length;
      const status = await agent.switchSource("non-existent-id");
      expect(status.reason).toBe("CAPCAM_SOURCE_UNAVAILABLE");
      expect(sender.calls.length).toBe(callCountBefore);
      expect(sender.track).toBe(trackA);
    });
  });

  describe("3. Target disappearance & lifecycle handling", () => {
    it("handles RTCPeerConnection.close() gracefully without getting stuck in ACTIVE", async () => {
      const originalTrack = new TrackSpy("original-camera", "video");
      const sender = new SenderSpy(originalTrack);
      const peer = new PeerConnectionSpy([sender]);
      const capcamTrack = new TrackSpy("capcam-track", "video");

      const streamProvider = new LocalStreamProvider(new StreamSpy([capcamTrack]));
      const agent = createControlledTargetAgent({
        origin: ORIGIN,
        streamProvider,
      });
      agent.registerTarget(peer);
      await agent.enable();
      expect(agent.getStatus().capcamActive).toBe(true);

      // Close the peer connection
      peer.close();

      const statusAfterClose = agent.getStatus();
      expect(statusAfterClose.capcamActive).toBe(false);

      // Re-detect reflects disconnected state
      const detected = await agent.detect();
      expect(detected.supported).toBe(false);
      expect(detected.state).toBe("UNSUPPORTED");
      expect(detected.reason).toBe("NO_WEBRTC_CONNECTION");
    });

    it("handles target unregister while ACTIVE without getting stuck", async () => {
      const originalTrack = new TrackSpy("original-camera", "video");
      const sender = new SenderSpy(originalTrack);
      const peer = new PeerConnectionSpy([sender]);
      const capcamTrack = new TrackSpy("capcam-track", "video");

      const streamProvider = new LocalStreamProvider(new StreamSpy([capcamTrack]));
      const agent = createControlledTargetAgent({
        origin: ORIGIN,
        streamProvider,
      });
      agent.registerTarget(peer);
      await agent.enable();
      expect(agent.getStatus().capcamActive).toBe(true);

      // Unregister target peer connection
      agent.unregisterTarget(peer);

      const status = agent.getStatus();
      expect(status.capcamActive).toBe(false);
      expect(agent.getPeerConnectionState().connectionCount).toBe(0);
    });

    it("handles page navigation lifecycle event and marks state as BLOCKED", async () => {
      const originalTrack = new TrackSpy("original-camera", "video");
      const sender = new SenderSpy(originalTrack);
      const peer = new PeerConnectionSpy([sender]);
      const capcamTrack = new TrackSpy("capcam-track", "video");

      const streamProvider = new LocalStreamProvider(new StreamSpy([capcamTrack]));
      const agent = createControlledTargetAgent({
        origin: ORIGIN,
        streamProvider,
      });
      agent.registerTarget(peer);
      await agent.enable();

      const navStatus = await agent.handleTargetLifecycle("navigation");
      expect(navStatus.state).toBe("BLOCKED");
      expect(navStatus.reason).toBe("PAGE_NAVIGATED");
      expect(navStatus.capcamActive).toBe(false);
      expect(sender.track).toBe(originalTrack);
    });
  });

  describe("4. Command race conditions and idempotency", () => {
    it("handles concurrent START + STOP deterministically", async () => {
      const originalTrack = new TrackSpy("original-camera", "video");
      const sender = new SenderSpy(originalTrack);
      const peer = new PeerConnectionSpy([sender]);
      const capcamTrack = new TrackSpy("capcam-track", "video");

      const streamProvider = new LocalStreamProvider(new StreamSpy([capcamTrack]));
      const agent = createControlledTargetAgent({
        origin: ORIGIN,
        streamProvider,
      });
      agent.registerTarget(peer);

      // Launch enable and disable concurrently
      const [enableRes, disableRes] = await Promise.all([
        agent.enable(),
        agent.disable(),
      ]);

      expect(enableRes.state).toBe("ACTIVE");
      expect(disableRes.state).toBe("READY");
      expect(disableRes.capcamActive).toBe(false);
      expect(sender.track).toBe(originalTrack);
    });

    it("handles concurrent START + START deterministically", async () => {
      const originalTrack = new TrackSpy("original-camera", "video");
      const sender = new SenderSpy(originalTrack);
      const peer = new PeerConnectionSpy([sender]);
      const capcamTrack = new TrackSpy("capcam-track", "video");

      const streamProvider = new LocalStreamProvider(new StreamSpy([capcamTrack]));
      const agent = createControlledTargetAgent({
        origin: ORIGIN,
        streamProvider,
      });
      agent.registerTarget(peer);

      const [first, second] = await Promise.all([
        agent.enable(),
        agent.enable(),
      ]);

      expect(first.state).toBe("ACTIVE");
      expect(second.state).toBe("ACTIVE");
      expect(sender.calls).toEqual([capcamTrack]);
    });

    it("handles concurrent SOURCE_SWITCH + STOP deterministically", async () => {
      const originalTrack = new TrackSpy("original-camera", "video");
      const sender = new SenderSpy(originalTrack);
      const peer = new PeerConnectionSpy([sender]);
      const capcamTrack1 = new TrackSpy("capcam-1", "video");
      const capcamTrack2 = new TrackSpy("capcam-2", "video");

      const streamProvider = new LocalStreamProvider(new StreamSpy([capcamTrack1]));
      const agent = createControlledTargetAgent({
        origin: ORIGIN,
        streamProvider,
      });
      agent.registerTarget(peer);
      await agent.enable();

      const [switchRes, disableRes] = await Promise.all([
        agent.acceptSource(new StreamSpy([capcamTrack2])),
        agent.disable(),
      ]);

      expect(switchRes.state).toBe("ACTIVE");
      expect(disableRes.state).toBe("READY");
      expect(disableRes.capcamActive).toBe(false);
      expect(sender.track).toBe(originalTrack);
    });

    it("handles concurrent RESTORE + SOURCE_SWITCH deterministically", async () => {
      const originalTrack = new TrackSpy("original-camera", "video");
      const sender = new SenderSpy(originalTrack);
      const peer = new PeerConnectionSpy([sender]);
      const capcamTrack1 = new TrackSpy("capcam-1", "video");
      const capcamTrack2 = new TrackSpy("capcam-2", "video");

      const streamProvider = new LocalStreamProvider(new StreamSpy([capcamTrack1]));
      const agent = createControlledTargetAgent({
        origin: ORIGIN,
        streamProvider,
      });
      agent.registerTarget(peer);
      await agent.enable();

      const [disableRes, switchRes] = await Promise.all([
        agent.disable(),
        agent.acceptSource(new StreamSpy([capcamTrack2])),
      ]);

      expect(disableRes.state).toBe("READY");
      expect(switchRes.capcamActive).toBe(false);
      expect(sender.track).toBe(originalTrack);
    });
  });

  describe("5. Diagnostic events emission", () => {
    it("emits structured diagnostics throughout the full lifecycle", async () => {
      const events: CameraIntegrationDiagnostic[] = [];
      const diagnosticsSink = (diag: CameraIntegrationDiagnostic) => {
        events.push(diag);
      };

      const originalTrack = new TrackSpy("original-camera", "video");
      const sender = new SenderSpy(originalTrack);
      const peer = new PeerConnectionSpy([sender]);
      const capcamTrack = new TrackSpy("capcam-track", "video");

      const streamProvider = new LocalStreamProvider(new StreamSpy([capcamTrack]));
      const agent = createControlledTargetAgent({
        origin: ORIGIN,
        streamProvider,
        diagnostics: diagnosticsSink,
      });
      agent.registerTarget(peer);

      await agent.detect();
      await agent.enable();
      await agent.disable();
      await agent.destroy();

      const eventNames = events.map((e) => e.event);
      expect(eventNames).toContain("TARGET_DETECTED");
      expect(eventNames).toContain("TRACK_REPLACED");
      expect(eventNames).toContain("INTEGRATION_ENABLED");
      expect(eventNames).toContain("TRACK_RESTORED");
      expect(eventNames).toContain("INTEGRATION_DISABLED");

      // Verify no sensitive DOM or hardware info leaked in diagnostics
      for (const diag of events) {
        expect(diag.origin === ORIGIN || diag.origin === null).toBe(true);
        expect(typeof diag.occurredAt).toBe("number");
      }
    });
  });
});
