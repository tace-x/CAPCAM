import { describe, expect, it, vi } from "vitest";
import { createProductionCameraIntegration } from "../../src/camera-integration/camera-integration";
import { CameraIntegrationCore } from "../../src/camera-integration/camera-integration-core";
import {
  ChromeOptionalOriginPermissionBroker,
} from "../../src/camera-integration/permissions";
import {
  exactHostPermissionPattern,
  normalizeWebOrigin,
} from "../../src/camera-integration/origin";
import { ExactOriginTargetRegistry } from "../../src/camera-integration/target-registry";
import { PHASE_06_VERIFIED, detectCapabilities } from "../../src/config/capabilities";
import type {
  CameraIntegrationDiagnostic,
  CameraMediaStream,
  CameraVideoSender,
  CameraVideoTrack,
  CapCamStreamEvent,
  CapCamStreamProvider,
  OriginPermissionBroker,
  PermissionQueryResult,
  PermissionRequestResult,
  TargetAdapter,
  TargetDetection,
  TargetLifecycleEvent,
  Unsubscribe,
} from "../../src/camera-integration/types";

const ORIGIN = "https://call.example.test";
const PAGE_URL = `${ORIGIN}/room/7?invite=private-value`;

class FakeTrack implements CameraVideoTrack {
  readonly kind: string;
  readonly id: string;
  readonly deviceId: string;
  readonly groupId: string;
  readyState = "live";
  private readonly endedListeners = new Set<EventListener>();

  constructor(id = "raw-device-track-123", kind = "video") {
    this.id = id;
    this.deviceId = "sensitive-device-id";
    this.groupId = "sensitive-group-id";
    this.kind = kind;
  }

  addEventListener(_type: "ended", listener: EventListener): void {
    this.endedListeners.add(listener);
  }

  removeEventListener(_type: "ended", listener: EventListener): void {
    this.endedListeners.delete(listener);
  }

  end(): void {
    this.readyState = "ended";
    for (const listener of this.endedListeners) listener(new Event("ended"));
  }
}

class FakeStream implements CameraMediaStream {
  private currentActive = true;
  private readonly inactiveListeners = new Set<EventListener>();

  constructor(private readonly tracks: FakeTrack[]) {}

  get active(): boolean {
    return this.currentActive;
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
    this.currentActive = false;
    for (const listener of this.inactiveListeners) listener(new Event("inactive"));
  }
}

class FakeSender implements CameraVideoSender {
  readonly calls: Array<CameraVideoTrack | null> = [];
  failure: "none" | "before-mutation" | "after-mutation" = "none";

  constructor(private currentTrack: CameraVideoTrack | null) {}

  get track(): CameraVideoTrack | null {
    return this.currentTrack;
  }

  async replaceTrack(track: CameraVideoTrack | null): Promise<void> {
    this.calls.push(track);
    if (this.failure === "before-mutation") {
      this.failure = "none";
      throw new Error("mock sender rejected replacement");
    }
    this.currentTrack = track;
    if (this.failure === "after-mutation") {
      this.failure = "none";
      throw new Error("mock sender rejected after mutation");
    }
  }
}

class FakeTargetAdapter implements TargetAdapter {
  detection: TargetDetection = {
    supported: true,
    hasWebRtcWorkflow: true,
    hasCameraWorkflow: true,
  };
  connected = true;
  senderAvailable = true;
  lifecycleUnsubscribeCount = 0;
  private readonly lifecycleListeners = new Set<(event: TargetLifecycleEvent) => void>();

  readonly detect = vi.fn(async (_origin: string): Promise<TargetDetection> => ({ ...this.detection }));
  readonly findVideoSender = vi.fn(async (): Promise<CameraVideoSender | null> => this.sender);
  readonly replaceVideoTrack = vi.fn(async (sender: CameraVideoSender, track: CameraVideoTrack): Promise<void> => {
    await sender.replaceTrack(track);
  });
  readonly restoreVideoTrack = vi.fn(async (sender: CameraVideoSender, track: CameraVideoTrack | null): Promise<void> => {
    await sender.replaceTrack(track);
  });
  readonly isConnected = vi.fn((): boolean => this.connected);
  readonly isSenderAvailable = vi.fn((_sender: CameraVideoSender): boolean => this.senderAvailable);
  readonly cleanup = vi.fn((): void => undefined);

  constructor(private readonly sender: CameraVideoSender | null) {}

  subscribeLifecycle(listener: (event: TargetLifecycleEvent) => void): Unsubscribe {
    this.lifecycleListeners.add(listener);
    return () => {
      this.lifecycleUnsubscribeCount += 1;
      this.lifecycleListeners.delete(listener);
    };
  }

  emitLifecycle(event: TargetLifecycleEvent): void {
    for (const listener of this.lifecycleListeners) listener(event);
  }
}

class FakePermissions implements OriginPermissionBroker {
  containsResult: PermissionQueryResult = "granted";
  requestResult: PermissionRequestResult = "granted";
  readonly revokedListeners = new Set<(origin: string) => void>();
  readonly contains = vi.fn(async (_origin: string): Promise<PermissionQueryResult> => this.containsResult);
  readonly request = vi.fn(async (_origin: string): Promise<PermissionRequestResult> => {
    if (this.requestResult === "granted") this.containsResult = "granted";
    return this.requestResult;
  });

  subscribeRevoked(listener: (origin: string) => void): Unsubscribe {
    this.revokedListeners.add(listener);
    return () => this.revokedListeners.delete(listener);
  }

  revoke(origin: string): void {
    for (const listener of this.revokedListeners) listener(origin);
  }
}

class FakeStreamProvider implements CapCamStreamProvider {
  readonly getActiveStream = vi.fn(async (): Promise<CameraMediaStream | null> => this.currentStream);
  private listener: ((event: CapCamStreamEvent) => void) | null = null;
  unsubscribeCount = 0;

  constructor(public currentStream: CameraMediaStream | null) {}

  subscribe(listener: (event: CapCamStreamEvent) => void): Unsubscribe {
    this.listener = listener;
    return () => {
      this.unsubscribeCount += 1;
      this.listener = null;
    };
  }

  emit(event: CapCamStreamEvent): void {
    this.listener?.(event);
  }
}

function createHarness(options: {
  origin?: string | null;
  phase06Verified?: boolean;
  permission?: PermissionQueryResult;
  permissionRequest?: PermissionRequestResult;
  detection?: Partial<TargetDetection>;
  hasAdapter?: boolean;
  originalTrack?: FakeTrack | null;
  capcamTrack?: FakeTrack;
} = {}) {
  let currentOrigin = options.origin === undefined ? PAGE_URL : options.origin;
  const original = options.originalTrack === undefined ? new FakeTrack("physical-camera-track") : options.originalTrack;
  const capcamTrack = options.capcamTrack ?? new FakeTrack("capcam-stream-track");
  const sender = new FakeSender(original);
  const stream = new FakeStream([capcamTrack]);
  const adapter = new FakeTargetAdapter(sender);
  adapter.detection = {
    supported: true,
    hasWebRtcWorkflow: true,
    hasCameraWorkflow: true,
    ...options.detection,
  };
  const permissions = new FakePermissions();
  if (options.permission !== undefined) permissions.containsResult = options.permission;
  if (options.permissionRequest !== undefined) permissions.requestResult = options.permissionRequest;
  const streams = new FakeStreamProvider(stream);
  const diagnostics: CameraIntegrationDiagnostic[] = [];
  const targetResolver = options.hasAdapter === false
    ? new ExactOriginTargetRegistry()
    : new ExactOriginTargetRegistry([{ origin: ORIGIN, adapter }]);
  const integration = new CameraIntegrationCore({
    getCurrentOrigin: () => currentOrigin,
    targets: targetResolver,
    permissions,
    streams,
    diagnostics: (event) => diagnostics.push(event),
    now: () => 1234,
  }, () => options.phase06Verified ?? true);

  return {
    integration,
    adapter,
    permissions,
    streams,
    diagnostics,
    sender,
    original,
    capcamTrack,
    stream,
    setOrigin: (origin: string | null) => { currentOrigin = origin; },
  };
}

async function activate(harness: ReturnType<typeof createHarness>): Promise<void> {
  const status = await harness.integration.enable();
  expect(status.state).toBe("ACTIVE");
}

describe("generic camera/WebRTC integration", () => {
  it("normalizes the current page origin and explicitly detects the supported WebRTC camera workflow", async () => {
    const harness = createHarness();
    const status = await harness.integration.initialize();

    expect(status).toMatchObject({
      state: "READY",
      origin: ORIGIN,
      supported: true,
      permission: "granted",
      capcamActive: false,
    });
    expect(harness.adapter.detect).toHaveBeenCalledWith(ORIGIN);
    expect(harness.permissions.contains).toHaveBeenCalledWith(ORIGIN);
    expect(harness.permissions.request).not.toHaveBeenCalled();
    expect(harness.diagnostics.map((event) => event.event)).toContain("TARGET_DETECTED");
    expect(normalizeWebOrigin(PAGE_URL)).toBe(ORIGIN);
  });

  it("rejects an unknown origin without resolving or injecting into arbitrary pages", async () => {
    const harness = createHarness({ origin: "https://unlisted.example.test/meeting", hasAdapter: false });
    const status = await harness.integration.detect();

    expect(status).toMatchObject({ state: "UNSUPPORTED", supported: false, reason: "NO_SUPPORTED_TARGET_ADAPTER" });
    expect(harness.permissions.contains).not.toHaveBeenCalled();
    expect(harness.permissions.request).not.toHaveBeenCalled();
  });

  it.each([
    ["no WebRTC workflow", { hasWebRtcWorkflow: false }],
    ["no camera workflow", { hasCameraWorkflow: false }],
    ["adapter says unsupported", { supported: false }],
  ])("requires explicit supported-target detection (%s)", async (_label, detection) => {
    const harness = createHarness({ detection });
    const status = await harness.integration.detect();
    expect(status.state).toBe("UNSUPPORTED");
    expect(status.supported).toBe(false);
    expect(harness.permissions.contains).not.toHaveBeenCalled();
  });

  it("requires an exact-origin registration and rejects wildcard or non-normalized registrations", () => {
    const adapter = new FakeTargetAdapter(new FakeSender(new FakeTrack()));
    expect(() => new ExactOriginTargetRegistry([{ origin: "https://*.example.test", adapter }])).toThrow();
    expect(() => new ExactOriginTargetRegistry([{ origin: `${ORIGIN}/room`, adapter }])).toThrow();
    expect(new ExactOriginTargetRegistry([{ origin: ORIGIN, adapter }]).resolve(ORIGIN)).toBe(adapter);
    expect(new ExactOriginTargetRegistry([{ origin: ORIGIN, adapter }]).resolve("https://other.example.test")).toBeNull();
  });

  it("publishes cloned status snapshots to API subscribers across lifecycle transitions", async () => {
    const harness = createHarness();
    const snapshots: string[] = [];
    const unsubscribe = harness.integration.subscribeStatus((status) => snapshots.push(status.state));
    await harness.integration.initialize();
    await harness.integration.enable();
    await harness.integration.disable();
    unsubscribe();

    expect(snapshots).toContain("READY");
    expect(snapshots).toContain("ACTIVE");
    expect(snapshots).toContain("STOPPING");
    expect(snapshots.at(-1)).toBe("READY");
  });

  it("requests permission only after explicit enable and only for the detected origin", async () => {
    const harness = createHarness({ permission: "required", permissionRequest: "granted" });
    const ready = await harness.integration.detect();
    expect(ready.state).toBe("READY");
    expect(harness.permissions.request).not.toHaveBeenCalled();

    const activation = harness.integration.enable();
    // The permission API is invoked synchronously while the explicit user-gesture call stack is active.
    expect(harness.permissions.request).toHaveBeenCalledTimes(1);
    expect(harness.permissions.request).toHaveBeenCalledWith(ORIGIN);
    const active = await activation;
    expect(active.state).toBe("ACTIVE");
  });

  it("never defers an origin permission prompt outside the explicit activation stack", async () => {
    const harness = createHarness({ permission: "required", permissionRequest: "granted" });
    const firstAttempt = await harness.integration.enable();
    expect(firstAttempt).toMatchObject({ state: "READY", permission: "required", reason: "PERMISSION_REQUIRED" });
    expect(harness.permissions.request).not.toHaveBeenCalled();

    const userGestureAttempt = harness.integration.enable();
    expect(harness.permissions.request).toHaveBeenCalledTimes(1);
    expect(await userGestureAttempt).toMatchObject({ state: "ACTIVE", permission: "granted" });
  });

  it("revalidates the selected origin after permission prompting and sender discovery", async () => {
    const harness = createHarness({ permission: "required", permissionRequest: "granted" });
    await harness.integration.detect();
    harness.permissions.request.mockImplementationOnce(async () => {
      harness.setOrigin("https://navigated.example.test/next");
      return "granted";
    });
    const status = await harness.integration.enable();

    expect(status).toMatchObject({ state: "UNSUPPORTED", origin: "https://navigated.example.test" });
    expect(harness.permissions.request).toHaveBeenCalledWith(ORIGIN);
    expect(harness.adapter.findVideoSender).not.toHaveBeenCalled();
    expect(harness.sender.calls).toEqual([]);

    const afterDiscovery = createHarness();
    await afterDiscovery.integration.detect();
    afterDiscovery.adapter.findVideoSender.mockImplementationOnce(async () => {
      afterDiscovery.setOrigin("https://replaced.example.test/new-page");
      return afterDiscovery.sender;
    });
    const afterDiscoveryStatus = await afterDiscovery.integration.enable();
    expect(afterDiscoveryStatus).toMatchObject({ state: "BLOCKED", reason: "PAGE_NAVIGATED" });
    expect(afterDiscovery.sender.calls).toEqual([]);
  });

  it("blocks denied and unavailable permission results without discovering a sender", async () => {
    const denied = createHarness({ permission: "required", permissionRequest: "denied" });
    await denied.integration.detect();
    expect(await denied.integration.enable()).toMatchObject({ state: "BLOCKED", permission: "denied", reason: "PERMISSION_DENIED" });
    expect(denied.adapter.findVideoSender).not.toHaveBeenCalled();

    const unavailable = createHarness({ permission: "unavailable" });
    expect(await unavailable.integration.enable()).toMatchObject({ state: "BLOCKED", permission: "unavailable", reason: "PERMISSION_UNAVAILABLE" });
    expect(unavailable.permissions.request).not.toHaveBeenCalled();
    expect(unavailable.adapter.findVideoSender).not.toHaveBeenCalled();
  });

  it("uses only one declared exact host pattern and refuses non-default-port or undeclared origins", async () => {
    const chromePermissions = {
      contains: vi.fn(async ({ origins }: { origins: string[] }) => origins[0] === "https://call.example.test/*"),
      request: vi.fn(async ({ origins }: { origins: string[] }) => origins[0] === "https://call.example.test/*"),
    };
    const broker = new ChromeOptionalOriginPermissionBroker(chromePermissions, ["https://call.example.test/*"]);

    expect(exactHostPermissionPattern(ORIGIN)).toBe("https://call.example.test/*");
    expect(exactHostPermissionPattern("http://localhost:5173")).toBeNull();
    expect(await broker.contains(ORIGIN)).toBe("granted");
    expect(await broker.request(`${ORIGIN}/room`)).toBe("granted");
    expect(chromePermissions.request).toHaveBeenCalledWith({ origins: ["https://call.example.test/*"] });
    expect(await broker.contains("https://other.example.test")).toBe("unavailable");
    expect(await broker.request("https://call.example.test:8443")).toBe("unavailable");
    expect(chromePermissions.contains).toHaveBeenCalledTimes(1);
    expect(chromePermissions.request).toHaveBeenCalledTimes(1);

    const undeclared = new ChromeOptionalOriginPermissionBroker(chromePermissions, []);
    expect(await undeclared.contains(ORIGIN)).toBe("unavailable");
    expect(await undeclared.request(ORIGIN)).toBe("unavailable");
    expect(chromePermissions.request).toHaveBeenCalledTimes(1);
  });

  it("does not activate, prompt, discover a sender, or replace a track while Phase 06 is unverified", async () => {
    expect(PHASE_06_VERIFIED).toBe(false);
    expect(detectCapabilities().cameraReplacement).toBe(false);
    const harness = createHarness({ phase06Verified: false });
    const status = await harness.integration.enable();

    expect(status).toMatchObject({ state: "BLOCKED_PHASE_06_VERIFICATION", origin: ORIGIN, reason: "BLOCKED_PHASE_06_VERIFICATION", capcamActive: false });
    expect(harness.permissions.contains).not.toHaveBeenCalled();
    expect(harness.permissions.request).not.toHaveBeenCalled();
    expect(harness.adapter.detect).not.toHaveBeenCalled();
    expect(harness.adapter.findVideoSender).not.toHaveBeenCalled();
    expect(harness.sender.calls).toEqual([]);
    expect(harness.diagnostics.map((event) => event.event)).toContain("BLOCKED_PHASE_06_VERIFICATION");
  });

  it("pins the production factory to PHASE_06_VERIFIED rather than the test-only gate seam", async () => {
    const sender = new FakeSender(new FakeTrack("physical-camera-track"));
    const adapter = new FakeTargetAdapter(sender);
    const permissions = new FakePermissions();
    const streams = new FakeStreamProvider(new FakeStream([new FakeTrack("capcam-track")]));
    const production = createProductionCameraIntegration({
      getCurrentOrigin: () => PAGE_URL,
      targets: new ExactOriginTargetRegistry([{ origin: ORIGIN, adapter }]),
      permissions,
      streams,
    });

    expect((await production.enable()).state).toBe("BLOCKED_PHASE_06_VERIFICATION");
    expect(permissions.request).not.toHaveBeenCalled();
    expect(adapter.findVideoSender).not.toHaveBeenCalled();
  });

  it("preserves the original sender track, uses the CapCam track, and restores on disable", async () => {
    const harness = createHarness();
    await activate(harness);

    expect(harness.adapter.findVideoSender).toHaveBeenCalledTimes(1);
    expect(harness.adapter.replaceVideoTrack).toHaveBeenCalledWith(harness.sender, harness.capcamTrack);
    expect(harness.sender.track).toBe(harness.capcamTrack);
    expect(harness.integration.getStatus()).toMatchObject({
      state: "ACTIVE",
      capcamActive: true,
      originalTrackAvailable: true,
      activeTrackAvailable: true,
    });

    const status = await harness.integration.disable();
    expect(status.state).toBe("READY");
    expect(status.capcamActive).toBe(false);
    expect(harness.sender.track).toBe(harness.original);
    expect(harness.original?.readyState).toBe("live");
    expect(harness.capcamTrack.readyState).toBe("live");
    expect(harness.diagnostics.map((event) => event.event)).toContain("TRACK_RESTORED");
  });

  it("refuses to replace a sender when its original track is absent or non-video", async () => {
    const noTrack = createHarness({ originalTrack: null });
    expect(await noTrack.integration.enable()).toMatchObject({ state: "BLOCKED", reason: "ORIGINAL_TRACK_UNAVAILABLE" });
    expect(noTrack.sender.calls).toEqual([]);

    const audio = new FakeTrack("audio-track", "audio");
    const nonVideo = createHarness({ originalTrack: audio });
    expect(await nonVideo.integration.enable()).toMatchObject({ state: "BLOCKED", reason: "ORIGINAL_TRACK_UNAVAILABLE" });
    expect(nonVideo.sender.calls).toEqual([]);
  });

  it("replaces CapCam sources safely while retaining the original camera for later restoration", async () => {
    const harness = createHarness();
    await activate(harness);
    const nextTrack = new FakeTrack("next-capcam-source");
    const nextStream = new FakeStream([nextTrack]);

    const status = await harness.integration.replaceTrack(nextStream);
    expect(status).toMatchObject({ state: "ACTIVE", capcamActive: true, activeTrackAvailable: true });
    expect(harness.sender.track).toBe(nextTrack);
    expect(harness.sender.calls).toEqual([harness.capcamTrack, nextTrack]);
    expect(harness.original?.readyState).toBe("live");
    expect(harness.diagnostics.map((event) => event.event)).toContain("SOURCE_CHANGED");

    await harness.integration.disable();
    expect(harness.sender.track).toBe(harness.original);
  });

  it("handles source changes signaled by the existing CapCam stream manager", async () => {
    const harness = createHarness();
    await activate(harness);
    const nextTrack = new FakeTrack("provider-switched-track");
    const nextStream = new FakeStream([nextTrack]);

    harness.streams.emit({ type: "source-changed", stream: nextStream });
    await vi.waitFor(() => expect(harness.sender.track).toBe(nextTrack));
    expect(harness.integration.getStatus().state).toBe("ACTIVE");
    expect(harness.diagnostics.map((event) => event.event)).toContain("SOURCE_CHANGED");
  });

  it("restores the original track when the active CapCam track ends", async () => {
    const harness = createHarness();
    await activate(harness);
    harness.capcamTrack.end();

    const status = await harness.integration.handleTrackEnded(harness.capcamTrack);
    expect(status.state).toBe("READY");
    expect(status.capcamActive).toBe(false);
    expect(status.reason).toBe("CAPCAM_TRACK_ENDED");
    expect(harness.sender.track).toBe(harness.original);
    expect(harness.diagnostics.map((event) => event.event)).toContain("TRACK_ENDED");
  });

  it("restores on stream end, revocation, page lifecycle, and reload/navigation", async () => {
    const ended = createHarness();
    await activate(ended);
    ended.stream.end();
    await vi.waitFor(() => expect(ended.sender.track).toBe(ended.original));
    expect(ended.integration.getStatus().reason).toBe("STREAM_ENDED");

    const providerEnded = createHarness();
    await activate(providerEnded);
    await providerEnded.integration.handleCapCamStreamEvent({ type: "stream-ended" });
    expect(providerEnded.sender.track).toBe(providerEnded.original);

    const revoked = createHarness();
    await activate(revoked);
    revoked.permissions.revoke(ORIGIN);
    await vi.waitFor(() => expect(revoked.sender.track).toBe(revoked.original));
    expect(revoked.integration.getStatus()).toMatchObject({ state: "BLOCKED", permission: "revoked", reason: "PERMISSION_REVOKED" });

    const pagehide = createHarness();
    await activate(pagehide);
    expect((await pagehide.integration.handleTargetLifecycle("pagehide")).state).toBe("BLOCKED");
    expect(pagehide.sender.track).toBe(pagehide.original);

    const restart = createHarness();
    await activate(restart);
    expect((await restart.integration.handleTargetLifecycle("extension-restart")).state).toBe("BLOCKED");
    expect(restart.sender.track).toBe(restart.original);

    const navigation = createHarness();
    await activate(navigation);
    navigation.setOrigin("https://new.example.test/next");
    const reinitialized = await navigation.integration.initialize();
    expect(navigation.sender.track).toBe(navigation.original);
    expect(reinitialized).toMatchObject({ state: "UNSUPPORTED", origin: "https://new.example.test", supported: false });
  });

  it("does not call a stale sender to restore after the target is disconnected", async () => {
    const harness = createHarness();
    await activate(harness);
    harness.adapter.connected = false;

    const status = await harness.integration.handleTargetLifecycle("target-disconnected");
    expect(status.state).toBe("BLOCKED");
    expect(status.reason).toBe("TARGET_DISCONNECTED");
    expect(harness.adapter.restoreVideoTrack).not.toHaveBeenCalled();
    expect(harness.diagnostics.map((event) => event.event)).toContain("TARGET_DISCONNECTED");
  });

  it("detects sender disappearance and avoids calling a stale RTCRtpSender during cleanup", async () => {
    const harness = createHarness();
    await activate(harness);
    harness.adapter.senderAvailable = false;

    const status = await harness.integration.disable();
    expect(status).toMatchObject({ state: "BLOCKED", reason: "SENDER_DISAPPEARED", capcamActive: false });
    expect(harness.adapter.restoreVideoTrack).not.toHaveBeenCalled();
    expect(harness.adapter.replaceVideoTrack).toHaveBeenCalledTimes(1);
  });

  it("uses a null detach when the original track has ended and never stops caller-owned tracks", async () => {
    const harness = createHarness();
    await activate(harness);
    harness.original!.readyState = "ended";

    const status = await harness.integration.disable();
    expect(status.state).toBe("READY");
    expect(harness.adapter.restoreVideoTrack).toHaveBeenCalledWith(harness.sender, null);
    expect(harness.sender.track).toBeNull();
    expect(harness.capcamTrack.readyState).toBe("live");
  });

  it("rolls back a partially-applied first replacement and reports restoration errors without losing cleanup references", async () => {
    const partial = createHarness();
    partial.sender.failure = "after-mutation";
    const failedStatus = await partial.integration.enable();
    expect(failedStatus.state).toBe("ERROR");
    expect(partial.sender.track).toBe(partial.original);
    expect(partial.adapter.restoreVideoTrack).toHaveBeenCalledWith(partial.sender, partial.original);

    const retryable = createHarness();
    await activate(retryable);
    retryable.adapter.restoreVideoTrack.mockRejectedValueOnce(new Error("restore rejected"));
    retryable.adapter.restoreVideoTrack.mockRejectedValueOnce(new Error("detach rejected"));
    const failedRestore = await retryable.integration.disable();
    expect(failedRestore.state).toBe("ERROR");
    expect(failedRestore.reason).toBe("RESTORE_AND_DETACH_FAILED");
    expect(failedRestore.capcamActive).toBe(true);
    expect(retryable.integration.getStatus().capcamActive).toBe(true);
  });

  it("retains retryable sender references when destroy cannot restore, then recovers cleanly", async () => {
    const harness = createHarness();
    await activate(harness);
    harness.adapter.restoreVideoTrack.mockRejectedValueOnce(new Error("restore rejected"));
    harness.adapter.restoreVideoTrack.mockRejectedValueOnce(new Error("detach rejected"));

    const failed = await harness.integration.destroy();
    expect(failed).toMatchObject({ state: "ERROR", reason: "RESTORE_AND_DETACH_FAILED", capcamActive: true });
    expect(harness.sender.track).toBe(harness.capcamTrack);
    expect(harness.adapter.cleanup).not.toHaveBeenCalled();

    const recovered = await harness.integration.destroy();
    expect(recovered.state).toBe("IDLE");
    expect(harness.sender.track).toBe(harness.original);
    expect(harness.adapter.cleanup).toHaveBeenCalledTimes(1);
  });

  it("reports diagnostics without device/group IDs, track IDs, or raw media", async () => {
    const harness = createHarness();
    await activate(harness);
    const serialized = JSON.stringify({ status: harness.integration.getStatus(), diagnostics: harness.diagnostics });

    expect(serialized).not.toContain("sensitive-device-id");
    expect(serialized).not.toContain("sensitive-group-id");
    expect(serialized).not.toContain("physical-camera-track");
    expect(serialized).not.toContain("capcam-stream-track");
    expect(serialized).not.toContain("rawFrame");
    expect(serialized).not.toContain("invite=private-value");
  });

  it("cleans up lifecycle subscriptions and adapter resources idempotently", async () => {
    const harness = createHarness();
    await activate(harness);
    const status = await harness.integration.destroy();

    expect(status.state).toBe("IDLE");
    expect(harness.sender.track).toBe(harness.original);
    expect(harness.adapter.cleanup).toHaveBeenCalledTimes(1);
    expect(harness.adapter.lifecycleUnsubscribeCount).toBe(1);
    expect(harness.streams.unsubscribeCount).toBe(1);
    expect(harness.permissions.revokedListeners.size).toBe(0);
    expect((await harness.integration.destroy()).state).toBe("IDLE");
    expect(harness.adapter.cleanup).toHaveBeenCalledTimes(1);
  });

  it("ignores revocation events for an origin other than the selected page origin", async () => {
    const harness = createHarness();
    await activate(harness);
    await harness.integration.handlePermissionRevoked("https://other.example.test");

    expect(harness.integration.getStatus().state).toBe("ACTIVE");
    expect(harness.sender.track).toBe(harness.capcamTrack);
  });
});

describe("origin and Chrome permission boundary", () => {
  it("rejects non-web, credentialed, malformed, and port-broadening origins", () => {
    expect(normalizeWebOrigin("chrome-extension://abc123/page.html")).toBeNull();
    expect(normalizeWebOrigin("https://user:secret@example.test/path")).toBeNull();
    expect(normalizeWebOrigin("not a url")).toBeNull();
    expect(exactHostPermissionPattern("http://localhost:3000")).toBeNull();
  });

  it("maps only declared exact-origin Chrome revocations back to the selected web origin", () => {
    const removedEvent = {
      listener: undefined as ((permissions: { origins?: string[] }) => void) | undefined,
      addListener(listener: (permissions: { origins?: string[] }) => void): void {
        this.listener = listener;
      },
      removeListener(listener: (permissions: { origins?: string[] }) => void): void {
        if (this.listener === listener) this.listener = undefined;
      },
      dispatch(permissions: { origins?: string[] }): void {
        this.listener?.(permissions);
      },
    };
    const chromePermissions = {
      contains: vi.fn(async (): Promise<boolean> => true),
      request: vi.fn(async (): Promise<boolean> => true),
      onRemoved: removedEvent,
    };
    const broker = new ChromeOptionalOriginPermissionBroker(chromePermissions, ["https://call.example.test/*"]);
    const revoked: string[] = [];
    const unsubscribe = broker.subscribeRevoked((origin) => revoked.push(origin));

    removedEvent.dispatch({ origins: ["https://call.example.test/*", "https://*.example.test/*"] });
    expect(revoked).toEqual([ORIGIN]);
    unsubscribe();
    expect(removedEvent.listener).toBeUndefined();
  });
});
