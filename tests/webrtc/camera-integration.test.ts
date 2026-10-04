import { describe, expect, it, vi } from "vitest";
import {
  CameraIntegration,
  isCameraIntegrationSupported,
  type CameraApiSupport,
  type IntegrationTrack,
  type ReplaceableVideoSender,
} from "./camera-integration";

const allApis: CameraApiSupport = {
  getUserMedia: true,
  mediaStream: true,
  peerConnection: true,
  replaceTrack: true,
};

class FakeTrack implements IntegrationTrack {
  constructor(
    readonly id: string,
    readonly kind = "video",
    public readyState = "live",
  ) {}
}

class FakeSender implements ReplaceableVideoSender<FakeTrack> {
  calls: Array<string | null> = [];
  rejectNext = false;

  constructor(public track: FakeTrack | null) {}

  async replaceTrack(track: FakeTrack | null): Promise<void> {
    this.calls.push(track?.id ?? null);
    if (this.rejectNext) {
      this.rejectNext = false;
      throw new Error("sender replacement rejected");
    }
    this.track = track;
  }
}

function createIntegration(support: CameraApiSupport = allApis) {
  const diagnostics = vi.fn();
  const integration = new CameraIntegration<FakeTrack>(() => support, diagnostics);
  return { integration, diagnostics };
}

describe("controlled local CameraIntegration", () => {
  it("detects required browser APIs and initializes without patching getUserMedia", async () => {
    const { integration, diagnostics } = createIntegration();
    expect(isCameraIntegrationSupported(allApis)).toBe(true);
    expect(integration.detect()).toEqual(allApis);
    expect((await integration.initialize()).state).toBe("READY");
    expect(diagnostics).toHaveBeenCalledWith(expect.objectContaining({ event: "target.detected" }));
    expect(diagnostics).toHaveBeenCalledWith(expect.objectContaining({ event: "integration.initialized" }));
  });

  it("enables, replaces, disables, and restores the original live camera track", async () => {
    const { integration, diagnostics } = createIntegration();
    const camera = new FakeTrack("physical-camera");
    const imageTrack = new FakeTrack("capcam-image");
    const videoTrack = new FakeTrack("capcam-video");
    const sender = new FakeSender(camera);

    expect((await integration.enable(sender, imageTrack)).state).toBe("ACTIVE");
    expect(sender.track).toBe(imageTrack);
    expect((await integration.replaceTrack(videoTrack)).activeTrackId).toBe("capcam-video");
    expect(sender.track).toBe(videoTrack);

    expect((await integration.disable()).state).toBe("OFF");
    expect(sender.track).toBe(camera);
    expect(camera.readyState).toBe("live");
    expect(imageTrack.readyState).toBe("live");
    expect(diagnostics).toHaveBeenCalledWith(expect.objectContaining({ event: "track.attached" }));
    expect(diagnostics).toHaveBeenCalledWith(expect.objectContaining({ event: "track.replaced" }));
    expect(diagnostics).toHaveBeenCalledWith(expect.objectContaining({ event: "integration.disabled" }));
  });

  it("serializes rapid ON/OFF toggles and leaves one final active track", async () => {
    const { integration } = createIntegration();
    const camera = new FakeTrack("camera");
    const virtual = new FakeTrack("virtual");
    const sender = new FakeSender(camera);

    await Promise.all([
      integration.enable(sender, virtual),
      integration.disable(),
      integration.enable(sender, virtual),
    ]);

    expect(integration.getStatus()).toMatchObject({ state: "ACTIVE", activeTrackId: "virtual" });
    expect(sender.track).toBe(virtual);
    expect(sender.calls).toEqual(["virtual", "camera", "virtual"]);
    await integration.disable();
    expect(sender.track).toBe(camera);
  });

  it("is idempotent for repeated enable/disable requests and preserves the original fallback", async () => {
    const { integration } = createIntegration();
    const camera = new FakeTrack("camera");
    const virtual = new FakeTrack("virtual");
    const sender = new FakeSender(camera);

    await integration.enable(sender, virtual);
    await integration.enable(sender, virtual);
    expect(sender.calls).toEqual(["virtual"]);
    await integration.disable();
    await integration.disable();
    expect(sender.calls).toEqual(["virtual", "camera"]);
    expect(sender.track).toBe(camera);
  });

  it("reports unsupported APIs without touching the sender", async () => {
    const { integration } = createIntegration({ ...allApis, replaceTrack: false });
    const sender = new FakeSender(new FakeTrack("camera"));
    const status = await integration.initialize();

    expect(status.state).toBe("TARGET_UNSUPPORTED");
    expect(status.supported).toBe(false);
    await expect(integration.enable(sender, new FakeTrack("virtual"))).rejects.toThrow(/replaceTrack/);
    expect(sender.calls).toEqual([]);
  });

  it("rejects audio or ended replacement tracks without changing the active sender", async () => {
    const { integration } = createIntegration();
    const camera = new FakeTrack("camera");
    const virtual = new FakeTrack("virtual");
    const sender = new FakeSender(camera);
    await integration.enable(sender, virtual);

    await expect(integration.replaceTrack(new FakeTrack("audio", "audio"))).rejects.toThrow(/video track/);
    const ended = new FakeTrack("ended");
    ended.readyState = "ended";
    await expect(integration.replaceTrack(ended)).rejects.toThrow(/not live/);
    expect(sender.track).toBe(virtual);
    expect(integration.getStatus()).toMatchObject({ state: "ACTIVE", activeTrackId: "virtual" });
  });

  it("retains the active sender on replacement failure and can still disable cleanly", async () => {
    const { integration } = createIntegration();
    const camera = new FakeTrack("camera");
    const virtualA = new FakeTrack("virtual-a");
    const sender = new FakeSender(camera);
    await integration.enable(sender, virtualA);

    sender.rejectNext = true;
    await expect(integration.replaceTrack(new FakeTrack("virtual-b"))).rejects.toThrow("sender replacement rejected");
    expect(sender.track).toBe(virtualA);
    expect(integration.getStatus()).toMatchObject({ state: "ACTIVE", activeTrackId: "virtual-a", error: "sender replacement rejected" });

    await integration.disable();
    expect(sender.track).toBe(camera);
    expect(integration.getStatus().state).toBe("OFF");
  });

  it("detaches instead of restoring an already-ended physical camera track", async () => {
    const { integration } = createIntegration();
    const camera = new FakeTrack("camera");
    const virtual = new FakeTrack("virtual");
    const sender = new FakeSender(camera);
    await integration.enable(sender, virtual);
    camera.readyState = "ended";

    await integration.disable();
    expect(sender.track).toBeNull();
    expect(integration.getStatus().state).toBe("OFF");
  });

  it("recovers to the original camera when the active synthetic track ends", async () => {
    const { integration, diagnostics } = createIntegration();
    const camera = new FakeTrack("camera");
    const virtual = new FakeTrack("virtual");
    const sender = new FakeSender(camera);
    await integration.enable(sender, virtual);
    virtual.readyState = "ended";

    const status = await integration.handleTrackEnded("virtual");
    expect(status.state).toBe("OFF");
    expect(sender.track).toBe(camera);
    expect(diagnostics).toHaveBeenCalledWith(expect.objectContaining({ event: "integration.error" }));
    expect(diagnostics).toHaveBeenCalledWith(expect.objectContaining({ event: "integration.disabled" }));
  });

  it("destroys idempotently and releases references without stopping caller-owned tracks", async () => {
    const { integration, diagnostics } = createIntegration();
    const camera = new FakeTrack("camera");
    const virtual = new FakeTrack("virtual");
    const sender = new FakeSender(camera);
    await integration.enable(sender, virtual);

    expect((await integration.destroy()).state).toBe("OFF");
    expect(sender.track).toBe(camera);
    expect(camera.readyState).toBe("live");
    expect(virtual.readyState).toBe("live");
    expect((await integration.destroy()).state).toBe("OFF");
    expect(diagnostics).toHaveBeenCalledWith(expect.objectContaining({ event: "integration.destroyed" }));
  });
});
