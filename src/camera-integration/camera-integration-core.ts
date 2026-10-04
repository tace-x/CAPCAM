import { normalizeWebOrigin } from "./origin";
import type {
  CameraIntegrationDiagnostic,
  CameraIntegrationDiagnosticName,
  CameraIntegrationStatus,
  CameraIntegrationState,
  CameraMediaStream,
  CameraVideoSender,
  CameraVideoTrack,
  CapCamStreamEvent,
  CapCamStreamProvider,
  OriginPermissionBroker,
  PermissionRequestResult,
  PermissionState,
  TargetAdapter,
  TargetAdapterResolver,
  TargetDetection,
  TargetLifecycleEvent,
  Unsubscribe,
} from "./types";

export type CameraSource = CameraMediaStream | CameraVideoTrack;
export type Phase06Verification = () => boolean;

type PendingOriginPermissionRequest = {
  origin: string;
  result: Promise<PermissionRequestResult>;
};

export interface CameraIntegrationDependencies {
  /** Must describe the page context; the service worker/offscreen origin is not a target page. */
  getCurrentOrigin(): string | null;
  targets: TargetAdapterResolver;
  permissions: OriginPermissionBroker;
  streams: CapCamStreamProvider;
  diagnostics?: (event: CameraIntegrationDiagnostic) => void;
  now?: () => number;
}

const INITIAL_STATUS: CameraIntegrationStatus = {
  state: "IDLE",
  origin: null,
  supported: false,
  permission: "unknown",
  capcamActive: false,
  originalTrackAvailable: false,
  activeTrackAvailable: false,
  reason: null,
};

function isLiveVideoTrack(track: CameraVideoTrack | null | undefined): track is CameraVideoTrack {
  if (track === null || track === undefined) return false;
  try {
    return track.kind === "video" && track.readyState === "live";
  } catch {
    return false;
  }
}

function isStreamSource(source: CameraSource): source is CameraMediaStream {
  return typeof (source as CameraMediaStream).getVideoTracks === "function";
}

function firstLiveVideoTrack(stream: CameraMediaStream | null): CameraVideoTrack | null {
  if (stream === null) return null;
  try {
    if (!stream.active) return null;
    return stream.getVideoTracks().find((track) => isLiveVideoTrack(track)) ?? null;
  } catch {
    return null;
  }
}

function lifecycleReason(event: TargetLifecycleEvent): string {
  switch (event) {
    case "target-disconnected": return "TARGET_DISCONNECTED";
    case "pagehide": return "PAGE_HIDDEN";
    case "navigation": return "PAGE_NAVIGATED";
    case "extension-restart": return "EXTENSION_RESTARTED";
  }
}

function safeTargetReason(reason: TargetDetection["reasonCode"]): string {
  switch (reason) {
    case "UNSUPPORTED_ORIGIN":
    case "NO_WEBRTC_CONNECTION":
    case "NO_VIDEO_SENDER":
    case "AMBIGUOUS_VIDEO_SENDERS":
    case "TARGET_WORKFLOW_UNSUPPORTED":
      return reason;
    default:
      return "TARGET_WORKFLOW_UNSUPPORTED";
  }
}

/**
 * Internal testable coordinator core. Production callers receive the gated wrapper
 * from camera-integration.ts; this core is intentionally not re-exported by index.ts.
 */
export class CameraIntegrationCore {
  private status: CameraIntegrationStatus = { ...INITIAL_STATUS };
  private adapter: TargetAdapter | null = null;
  private subscribedTargetAdapter: TargetAdapter | null = null;
  private sender: CameraVideoSender | null = null;
  private originalTrack: CameraVideoTrack | null = null;
  private activeTrack: CameraVideoTrack | null = null;
  private activeStream: CameraMediaStream | null = null;
  private lastOriginalTrackAvailable = false;
  private lifecycleQueue: Promise<void> = Promise.resolve();
  private permissionUnsubscribe: Unsubscribe | null = null;
  private targetUnsubscribe: Unsubscribe | null = null;
  private streamUnsubscribe: Unsubscribe | null = null;
  private activeTrackEndedListener: EventListener | null = null;
  private activeStreamInactiveListener: EventListener | null = null;
  private readonly now: () => number;
  private readonly diagnostics: (event: CameraIntegrationDiagnostic) => void;
  private readonly phase06Verified: Phase06Verification;
  private readonly statusListeners = new Set<(status: CameraIntegrationStatus) => void>();

  constructor(
    private readonly dependencies: CameraIntegrationDependencies,
    phase06Verified: Phase06Verification,
  ) {
    this.now = dependencies.now ?? Date.now;
    this.diagnostics = dependencies.diagnostics ?? (() => undefined);
    this.phase06Verified = phase06Verified;
  }

  detect(): Promise<CameraIntegrationStatus> {
    return this.serialize(() => this.detectInternal());
  }

  initialize(): Promise<CameraIntegrationStatus> {
    return this.detect();
  }

  /**
   * Explicit activation. When detection is already ready and permission is required,
   * invoke Chrome's permission API synchronously in this user-gesture call stack before
   * serial work/awaits. If detection has not run yet, this returns the required state;
   * the caller must offer a subsequent explicit activation to request permission.
   */
  enable(source?: CameraSource): Promise<CameraIntegrationStatus> {
    let permissionRequest: PendingOriginPermissionRequest | null = null;
    let gateOpen = false;
    try {
      gateOpen = this.phase06Verified();
    } catch {
      gateOpen = false;
    }
    const currentOrigin = this.getNormalizedCurrentOrigin();
    if (gateOpen && this.status.supported && this.status.origin !== null
      && this.status.origin === currentOrigin
      && (this.status.state === "READY" || this.status.state === "TARGET_REGISTERED" || this.status.state === "SOURCE_READY" || this.status.state === "BLOCKED")
      && this.status.permission !== "granted" && this.status.permission !== "unavailable") {
      const requestedOrigin = this.status.origin;
      try {
        permissionRequest = {
          origin: requestedOrigin,
          result: this.dependencies.permissions.request(requestedOrigin).catch(() => "unavailable"),
        };
      } catch {
        permissionRequest = { origin: requestedOrigin, result: Promise.resolve("unavailable") };
      }
    }
    return this.serialize(() => this.enableInternal(source, permissionRequest));
  }

  /** Replaces only the currently controlled sender's CapCam video track. */
  replaceTrack(source: CameraSource): Promise<CameraIntegrationStatus> {
    return this.serialize(() => this.replaceTrackInternal(source));
  }

  disable(): Promise<CameraIntegrationStatus> {
    return this.serialize(() => this.disableInternal());
  }

  getStatus(): CameraIntegrationStatus {
    const activeTrackAvailable = isLiveVideoTrack(this.activeTrack);
    let capcamActive = false;
    try {
      capcamActive = activeTrackAvailable && this.sender !== null && this.sender.track === this.activeTrack
        && this.isSenderAvailable(this.adapter, this.sender);
    } catch {
      capcamActive = false;
    }
    return {
      ...this.status,
      capcamActive,
      originalTrackAvailable: isLiveVideoTrack(this.originalTrack) || this.lastOriginalTrackAvailable,
      activeTrackAvailable,
    };
  }

  subscribeStatus(listener: (status: CameraIntegrationStatus) => void): Unsubscribe {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  /** Idempotent cleanup. Tracks are caller-owned and are never stopped here. */
  destroy(): Promise<CameraIntegrationStatus> {
    return this.serialize(async () => {
      let cleanupFailed = false;
      try {
        const result = await this.disableInternal();
        cleanupFailed = result.capcamActive || result.reason === "RESTORE_AND_DETACH_FAILED";
      } catch {
        cleanupFailed = true;
      }

      // Keep the adapter and retryable sender/track references if restoration did not finish.
      // Clearing them here would hide an active CapCam sender and make later recovery impossible.
      if (cleanupFailed && this.sender !== null && this.activeTrack !== null) {
        this.status.state = "ERROR";
        this.status.reason = this.status.reason ?? "CLEANUP_FAILED";
        this.emit("INTEGRATION_ERROR", { operation: "destroy", cleanupCompleted: false });
        return this.getStatus();
      }

      this.detachActiveMediaListeners();
      this.unsubscribeAll();
      try {
        await this.adapter?.cleanup?.();
      } catch {
        cleanupFailed = true;
      }
      this.sender = null;
      this.originalTrack = null;
      this.activeTrack = null;
      this.activeStream = null;
      this.adapter = null;
      this.lastOriginalTrackAvailable = false;
      this.status = {
        ...INITIAL_STATUS,
        state: cleanupFailed ? "ERROR" : "IDLE",
        reason: cleanupFailed ? "CLEANUP_FAILED" : null,
      };
      this.emit(cleanupFailed ? "INTEGRATION_ERROR" : "INTEGRATION_DISABLED", {
        operation: "destroy",
        cleanupCompleted: !cleanupFailed,
      });
      return this.getStatus();
    });
  }

  /** Public for deterministic lifecycle adapters and unit coverage. */
  handleTrackEnded(track: CameraVideoTrack): Promise<CameraIntegrationStatus> {
    return this.serialize(() => this.handleTrackEndedInternal(track));
  }

  /** Public for page/extension lifecycle adapters. */
  handleTargetLifecycle(event: TargetLifecycleEvent): Promise<CameraIntegrationStatus> {
    return this.serialize(() => this.handleTargetLifecycleInternal(event));
  }

  /** Public for permission adapters when Chrome reports a selected-origin revocation. */
  handlePermissionRevoked(origin: string): Promise<CameraIntegrationStatus> {
    return this.serialize(async () => {
      await this.handlePermissionRevokedInternal(origin);
      return this.getStatus();
    });
  }

  /** Public for the existing CapCam stream manager to signal a source change or end. */
  handleCapCamStreamEvent(event: CapCamStreamEvent): Promise<CameraIntegrationStatus> {
    return this.serialize(async () => {
      await this.handleStreamProviderEvent(event);
      return this.getStatus();
    });
  }

  private async detectInternal(): Promise<CameraIntegrationStatus> {
    const previousOrigin = this.status.origin;
    const previousPermission = this.status.permission;
    const nextOrigin = this.getNormalizedCurrentOrigin();
    if (this.status.state === "ACTIVE" && nextOrigin !== this.status.origin) {
      await this.terminateActive("PAGE_NAVIGATED", "BLOCKED", true);
    } else if (this.status.state === "ERROR" && this.sender !== null && this.activeTrack !== null) {
      await this.terminateActive("REINITIALIZATION", "BLOCKED", true);
    }
    if (this.status.state === "ERROR" && this.sender !== null && this.activeTrack !== null) return this.getStatus();

    if (nextOrigin === null) {
      this.setAdapter(null);
      this.status = {
        ...this.status,
        state: "UNSUPPORTED",
        origin: null,
        supported: false,
        permission: "unknown",
        reason: "UNSUPPORTED_ORIGIN",
        capcamActive: false,
        activeTrackAvailable: false,
      };
      this.emit("TARGET_UNSUPPORTED");
      return this.getStatus();
    }

    if (this.status.state === "ACTIVE" && this.status.origin === nextOrigin) {
      if (this.sender === null || this.adapter === null || !this.isSenderAvailable(this.adapter, this.sender)) {
        await this.terminateActive("SENDER_DISAPPEARED", "BLOCKED", false);
        return this.getStatus();
      }
      const permission = await this.safeContains(nextOrigin);
      if (permission !== "granted") {
        this.status.permission = permission === "required" ? "revoked" : "unavailable";
        await this.terminateActive(
          permission === "required" ? "PERMISSION_REVOKED" : "PERMISSION_UNAVAILABLE",
          "BLOCKED",
          true,
        );
      } else {
        this.status.permission = "granted";
        return this.getStatus();
      }
    }
    if (this.status.state === "ERROR" && this.sender !== null && this.activeTrack !== null) return this.getStatus();

    this.status = {
      ...this.status,
      state: "DETECTING",
      origin: nextOrigin,
      supported: false,
      reason: null,
      capcamActive: false,
      activeTrackAvailable: false,
    };
    this.publishStatus();

    let adapter: TargetAdapter | null;
    try {
      adapter = this.dependencies.targets.resolve(nextOrigin);
    } catch {
      return this.fail("TARGET_RESOLUTION_FAILED", { operation: "detect" });
    }
    if (adapter === null) {
      this.setAdapter(null);
      this.status = {
        ...this.status,
        state: "UNSUPPORTED",
        permission: "unknown",
        reason: "NO_SUPPORTED_TARGET_ADAPTER",
      };
      this.emit("TARGET_UNSUPPORTED");
      return this.getStatus();
    }

    let detection: TargetDetection;
    try {
      detection = await adapter.detect(nextOrigin);
    } catch {
      return this.fail("TARGET_DETECTION_FAILED", { operation: "detect" });
    }
    const supported = detection.supported && detection.hasWebRtcWorkflow && detection.hasCameraWorkflow;
    this.status.supported = supported;
    this.emit("TARGET_DETECTED", {
      adapterSupported: detection.supported,
      hasWebRtcWorkflow: detection.hasWebRtcWorkflow,
      hasCameraWorkflow: detection.hasCameraWorkflow,
    });

    if (!supported) {
      this.setAdapter(adapter);
      this.status.state = "UNSUPPORTED";
      this.status.reason = safeTargetReason(detection.reasonCode);
      this.emit("TARGET_UNSUPPORTED");
      return this.getStatus();
    }

    try {
      this.setAdapter(adapter);
      this.ensureTargetSubscription(adapter);
      this.ensurePermissionSubscription();
      this.ensureStreamSubscription();
    } catch {
      return this.fail("LIFECYCLE_SUBSCRIPTION_FAILED", { operation: "subscribe" });
    }

    const permission = await this.safeContains(nextOrigin);
    this.status.permission = permission === "required" && previousOrigin === nextOrigin
      && (previousPermission === "denied" || previousPermission === "revoked")
      ? previousPermission
      : permission;

    let stream: CameraMediaStream | null = null;
    try {
      stream = await this.dependencies.streams.getActiveStream();
    } catch {
      stream = null;
    }
    this.activeStream = null;
    const capcamAvailable = firstLiveVideoTrack(stream) !== null;
    if (permission === "unavailable") {
      this.status.state = "BLOCKED";
      this.status.reason = "PERMISSION_UNAVAILABLE";
      this.emit("INTEGRATION_ERROR", { operation: "permission-check" });
      return this.getStatus();
    }

    this.activeStream = stream;
    this.status.state = "READY";
    this.status.reason = permission === "required" ? "PERMISSION_REQUIRED"
      : capcamAvailable ? null : "CAPCAM_STREAM_UNAVAILABLE";
    if (permission === "required") this.emit("PERMISSION_REQUIRED");
    if (permission === "granted") this.emit("PERMISSION_GRANTED");
    this.emit("INTEGRATION_READY", { capcamAvailable });
    return this.getStatus();
  }

  private async enableInternal(
    source: CameraSource | undefined,
    permissionRequest: PendingOriginPermissionRequest | null,
  ): Promise<CameraIntegrationStatus> {
    if (!this.phase06Verified()) {
      const origin = this.getNormalizedCurrentOrigin();
      if (this.status.state === "ACTIVE") await this.terminateActive("BLOCKED_PHASE_06_VERIFICATION", "BLOCKED_PHASE_06_VERIFICATION", true);
      if (this.sender === null || this.activeTrack === null) {
        this.status = {
          ...this.status,
          state: "BLOCKED_PHASE_06_VERIFICATION",
          origin,
          supported: this.status.supported,
          permission: this.status.permission,
          reason: "BLOCKED_PHASE_06_VERIFICATION",
        };
      }
      this.emit("BLOCKED_PHASE_06_VERIFICATION", { activationAttempted: true });
      return this.getStatus();
    }

    if (this.status.state === "ACTIVE") {
      return source === undefined ? this.getStatus() : this.replaceTrackInternal(source);
    }

    const detected = await this.detectInternal();
    if (permissionRequest !== null && permissionRequest.origin !== detected.origin) {
      if (detected.state === "READY" || detected.state === "TARGET_REGISTERED" || detected.state === "SOURCE_READY") {
        this.status.state = "BLOCKED";
        this.status.reason = "PAGE_NAVIGATED";
        this.emit("TARGET_DISCONNECTED", { lifecycle: "navigation" });
        return this.getStatus();
      }
      return detected;
    }
    if ((detected.state !== "READY" && detected.state !== "TARGET_REGISTERED" && detected.state !== "SOURCE_READY") || detected.origin === null || this.adapter === null) return detected;

    const permission: PermissionState = this.status.permission;
    if (permissionRequest !== null) {
      this.emit("PERMISSION_REQUIRED");
      const permissionResult = await permissionRequest.result;
      if (permissionResult !== "granted") {
        this.status.permission = permissionResult;
        this.status.state = "BLOCKED";
        this.status.reason = permissionResult === "denied" ? "PERMISSION_DENIED" : "PERMISSION_UNAVAILABLE";
        this.emit("INTEGRATION_ERROR", { operation: "permission-request", permission: permissionResult });
        return this.getStatus();
      }
      this.status.permission = "granted";
      this.emit("PERMISSION_GRANTED");
    } else if (permission !== "granted") {
      if (permission === "unavailable") {
        this.status.state = "BLOCKED";
        this.status.reason = "PERMISSION_UNAVAILABLE";
        this.emit("INTEGRATION_ERROR", { operation: "permission-request" });
        return this.getStatus();
      }
      this.status.state = permission === "denied" ? "BLOCKED" : "READY";
      this.status.reason = permission === "denied" ? "PERMISSION_DENIED" : "PERMISSION_REQUIRED";
      this.emit("PERMISSION_REQUIRED");
      return this.getStatus();
    }
    if (!await this.revalidateActivation(detected.origin)) return this.getStatus();

    const stream = source === undefined
      ? await this.safeGetStream()
      : isStreamSource(source) ? source : null;
    if (stream !== null) this.activeStream = stream;
    const track = source !== undefined && !isStreamSource(source)
      ? source
      : firstLiveVideoTrack(stream);
    if (!isLiveVideoTrack(track)) {
      this.status.state = "BLOCKED";
      this.status.reason = stream?.active === false ? "STREAM_ENDED" : "CAPCAM_TRACK_UNAVAILABLE";
      this.status.capcamActive = false;
      this.status.activeTrackAvailable = false;
      this.emit("INTEGRATION_ERROR", { operation: "stream-selection" });
      return this.getStatus();
    }

    let sender: CameraVideoSender | null;
    try {
      sender = await this.adapter.findVideoSender();
    } catch {
      return this.fail("SENDER_DISCOVERY_FAILED", { operation: "find-video-sender" });
    }
    if (sender === null || sender.track === null || sender.track.kind !== "video" || sender.track.readyState !== "live") {
      this.status.state = "BLOCKED";
      this.status.reason = sender === null ? "VIDEO_SENDER_NOT_FOUND" : "ORIGINAL_TRACK_UNAVAILABLE";
      this.emit("INTEGRATION_ERROR", { operation: "find-video-sender" });
      return this.getStatus();
    }
    if (!await this.revalidateActivation(detected.origin)) return this.getStatus();
    if (!this.isSenderAvailable(this.adapter, sender)) {
      this.status.state = "BLOCKED";
      this.status.reason = "SENDER_DISAPPEARED";
      this.emit("INTEGRATION_ERROR", { operation: "sender-revalidation" });
      return this.getStatus();
    }

    this.sender = sender;
    this.originalTrack = sender.track;
    this.lastOriginalTrackAvailable = true;
    this.activeTrack = track;
    this.activeStream = stream;
    try {
      await this.adapter.replaceVideoTrack(sender, track);
      if (sender.track !== track || !isLiveVideoTrack(track)) throw new Error("replacement-not-observed");
      this.status.state = "ACTIVE";
      this.status.reason = null;
      this.attachActiveMediaListeners();
      this.emit("TRACK_REPLACED", { operation: "enable" });
      this.emit("INTEGRATION_ENABLED");
      return this.getStatus();
    } catch {
      const cleanup = await this.restoreAfterFailedReplacement();
      const failureReason = !cleanup && this.status.reason === "SENDER_DISAPPEARED"
        ? "SENDER_DISAPPEARED"
        : cleanup ? "TRACK_REPLACEMENT_FAILED" : "TRACK_REPLACEMENT_AND_RESTORE_FAILED";
      return this.fail(failureReason, {
        operation: "enable",
        cleanupCompleted: cleanup,
      });
    }
  }

  private async replaceTrackInternal(source: CameraSource): Promise<CameraIntegrationStatus> {
    if (!this.phase06Verified()) {
      if (this.status.state === "ACTIVE") await this.terminateActive("BLOCKED_PHASE_06_VERIFICATION", "BLOCKED_PHASE_06_VERIFICATION", true);
      if (this.sender === null || this.activeTrack === null) {
        this.status.state = "BLOCKED_PHASE_06_VERIFICATION";
        this.status.reason = "BLOCKED_PHASE_06_VERIFICATION";
      }
      this.emit("BLOCKED_PHASE_06_VERIFICATION", { activationAttempted: true });
      return this.getStatus();
    }
    if (this.status.state !== "ACTIVE" || this.adapter === null || this.sender === null || this.activeTrack === null) {
      this.status.reason = "INTEGRATION_NOT_ACTIVE";
      this.emit("INTEGRATION_ERROR", { operation: "replace-track" });
      return this.getStatus();
    }
    if (!this.isSenderAvailable(this.adapter, this.sender)) {
      await this.terminateActive("SENDER_DISAPPEARED", "BLOCKED", false);
      return this.getStatus();
    }

    const currentPermission = this.status.origin === null ? "unavailable" : await this.safeContains(this.status.origin);
    if (currentPermission !== "granted") {
      this.status.permission = currentPermission === "required" ? "revoked" : "unavailable";
      await this.terminateActive(
        currentPermission === "required" ? "PERMISSION_REVOKED" : "PERMISSION_UNAVAILABLE",
        "BLOCKED",
        true,
      );
      return this.getStatus();
    }

    const stream = isStreamSource(source) ? source : null;
    const track = stream === null ? source as CameraVideoTrack : firstLiveVideoTrack(stream);
    if (!isLiveVideoTrack(track) || (stream !== null && !stream.active)) {
      this.status.reason = stream?.active === false ? "STREAM_ENDED" : "CAPCAM_TRACK_UNAVAILABLE";
      this.emit("INTEGRATION_ERROR", { operation: "replace-track" });
      return this.getStatus();
    }
    if (!this.isSenderAvailable(this.adapter, this.sender)) {
      await this.terminateActive("SENDER_DISAPPEARED", "BLOCKED", false);
      return this.getStatus();
    }
    if (track === this.activeTrack) {
      if (stream !== this.activeStream) {
        this.detachActiveMediaListeners();
        this.activeStream = stream;
        this.attachActiveMediaListeners();
        this.emit("SOURCE_CHANGED", { sourceChanged: true, sameTrack: true });
      }
      this.status.reason = null;
      return this.getStatus();
    }

    const previousTrack = this.activeTrack;
    try {
      await this.adapter.replaceVideoTrack(this.sender, track);
      if (this.sender.track !== track || !isLiveVideoTrack(track)) throw new Error("replacement-not-observed");
      this.detachActiveMediaListeners();
      this.activeTrack = track;
      this.activeStream = stream;
      this.attachActiveMediaListeners();
      this.status.reason = null;
      this.emit("TRACK_REPLACED", { operation: "source-change" });
      this.emit("SOURCE_CHANGED", { sourceChanged: true });
      return this.getStatus();
    } catch {
      this.activeTrack = previousTrack;
      try {
        await this.adapter.replaceVideoTrack(this.sender, previousTrack);
        if (this.sender.track !== previousTrack) throw new Error("source-rollback-not-observed");
        this.status.reason = "TRACK_REPLACEMENT_FAILED";
      } catch {
        await this.terminateActive("TRACK_REPLACEMENT_AND_ROLLBACK_FAILED", "ERROR", true);
      }
      this.emit("INTEGRATION_ERROR", { operation: "source-change" });
      return this.getStatus();
    }
  }

  private async disableInternal(): Promise<CameraIntegrationStatus> {
    if (this.sender === null || this.adapter === null) {
      if (this.status.state === "ACTIVE") {
        this.status.state = "ERROR";
        this.status.reason = "ACTIVE_SENDER_UNAVAILABLE";
        this.emit("INTEGRATION_ERROR", { operation: "disable" });
      }
      return this.getStatus();
    }
    if (this.status.state !== "ACTIVE" && this.activeTrack === null) return this.getStatus();
    await this.terminateActive(null, "READY", true);
    return this.getStatus();
  }

  private async terminateActive(
    reason: string | null,
    finalState: CameraIntegrationState,
    attemptRestore: boolean,
  ): Promise<void> {
    const sender = this.sender;
    const adapter = this.adapter;
    const originalTrack = this.originalTrack;
    this.status.state = "STOPPING";
    this.publishStatus();
    this.detachActiveMediaListeners();

    let restored = false;
    let restoreFailed = false;
    let restoreRequested = attemptRestore;
    let restorationAttempted = false;
    if (sender !== null && adapter !== null && !this.isSenderAvailable(adapter, sender)) {
      reason = reason ?? "SENDER_DISAPPEARED";
      finalState = "BLOCKED";
      restoreRequested = false;
    }
    if (sender !== null && adapter !== null && restoreRequested && this.isTargetConnected(adapter)) {
      restorationAttempted = true;
      const trackToRestore = isLiveVideoTrack(originalTrack) ? originalTrack : null;
      try {
        await adapter.restoreVideoTrack(sender, trackToRestore);
        if (sender.track !== trackToRestore) throw new Error("restore-not-observed");
        restored = trackToRestore !== null;
      } catch {
        restoreFailed = true;
        try {
          await adapter.restoreVideoTrack(sender, null);
          if (sender.track !== null) throw new Error("detach-not-observed");
        } catch {
          this.lastOriginalTrackAvailable = isLiveVideoTrack(originalTrack);
          this.status.state = "ERROR";
          this.status.reason = "RESTORE_AND_DETACH_FAILED";
          this.emit("INTEGRATION_ERROR", { operation: "restore", reason: this.status.reason });
          return;
        }
      }
    }

    this.lastOriginalTrackAvailable = isLiveVideoTrack(originalTrack);
    this.clearActiveReferences();
    this.status.state = restoreFailed ? "ERROR" : finalState;
    this.status.reason = restoreFailed ? "RESTORE_FAILED_DETACHED"
      : reason ?? (this.lastOriginalTrackAvailable ? null : originalTrack === null ? "ORIGINAL_TRACK_UNAVAILABLE" : "ORIGINAL_TRACK_ENDED");
    if (restored) this.emit("TRACK_RESTORED");
    this.emit("INTEGRATION_DISABLED", { restoredOriginalTrack: restored, restoreAttempted: restorationAttempted });
    if (reason === "PERMISSION_REVOKED") this.status.permission = "revoked";
    if (reason?.startsWith("PERMISSION_")) this.status.state = "BLOCKED";
    if (reason === "BLOCKED_PHASE_06_VERIFICATION") this.status.state = "BLOCKED_PHASE_06_VERIFICATION";
  }

  private async handleTrackEndedInternal(track: CameraVideoTrack): Promise<CameraIntegrationStatus> {
    if (this.status.state !== "ACTIVE" || this.activeTrack !== track) return this.getStatus();
    this.emit("TRACK_ENDED", { source: "capcam-track" });
    await this.terminateActive("CAPCAM_TRACK_ENDED", "READY", true);
    return this.getStatus();
  }

  private async handleStreamEnded(stream: CameraMediaStream): Promise<void> {
    if (this.status.state !== "ACTIVE" || this.activeStream !== stream) return;
    this.emit("TRACK_ENDED", { source: "capcam-stream" });
    await this.terminateActive("STREAM_ENDED", "READY", true);
  }

  private async handleTargetLifecycleInternal(event: TargetLifecycleEvent): Promise<CameraIntegrationStatus> {
    const reason = lifecycleReason(event);
    if (this.status.state === "ACTIVE") {
      this.emit("TARGET_DISCONNECTED", { lifecycle: event });
      await this.terminateActive(reason, "BLOCKED", event !== "target-disconnected" || this.isTargetConnected(this.adapter));
    } else {
      this.status.state = "BLOCKED";
      this.status.reason = reason;
      this.emit("TARGET_DISCONNECTED", { lifecycle: event });
    }
    return this.getStatus();
  }

  private async handlePermissionRevokedInternal(origin: string): Promise<void> {
    if (normalizeWebOrigin(origin) !== this.status.origin) return;
    this.status.permission = "revoked";
    if (this.status.state === "ACTIVE") {
      await this.terminateActive("PERMISSION_REVOKED", "BLOCKED", true);
    } else {
      this.status.state = "BLOCKED";
      this.status.reason = "PERMISSION_REVOKED";
    }
    this.emit("INTEGRATION_ERROR", { operation: "permission-revoked" });
  }

  private async handleStreamProviderEvent(event: CapCamStreamEvent): Promise<void> {
    if (event.type === "stream-ended") {
      if (this.activeStream !== null) await this.handleStreamEnded(this.activeStream);
      return;
    }
    if (this.status.state === "ACTIVE") await this.replaceTrackInternal(event.stream);
    else this.activeStream = event.stream;
  }

  private setAdapter(adapter: TargetAdapter | null): void {
    if (this.adapter === adapter) return;
    this.safeUnsubscribe(this.targetUnsubscribe);
    this.targetUnsubscribe = null;
    this.subscribedTargetAdapter = null;
    this.adapter = adapter;
  }

  private ensurePermissionSubscription(): void {
    if (this.permissionUnsubscribe !== null || this.dependencies.permissions.subscribeRevoked === undefined) return;
    this.permissionUnsubscribe = this.dependencies.permissions.subscribeRevoked((origin) => {
      void this.handlePermissionRevoked(origin);
    });
  }

  private ensureTargetSubscription(adapter: TargetAdapter): void {
    if (this.subscribedTargetAdapter === adapter) return;
    this.safeUnsubscribe(this.targetUnsubscribe);
    const unsubscribe = adapter.subscribeLifecycle?.((event) => {
      void this.handleTargetLifecycle(event);
    }) ?? null;
    this.targetUnsubscribe = unsubscribe;
    this.subscribedTargetAdapter = adapter;
  }

  private ensureStreamSubscription(): void {
    if (this.streamUnsubscribe !== null || this.dependencies.streams.subscribe === undefined) return;
    this.streamUnsubscribe = this.dependencies.streams.subscribe((event) => {
      void this.handleCapCamStreamEvent(event);
    });
  }

  private attachActiveMediaListeners(): void {
    this.detachActiveMediaListeners();
    if (this.activeTrack?.addEventListener !== undefined) {
      const track = this.activeTrack;
      const listener: EventListener = () => { void this.handleTrackEnded(track); };
      this.activeTrackEndedListener = listener;
      track.addEventListener?.("ended", listener);
    }
    if (this.activeStream?.addEventListener !== undefined) {
      const stream = this.activeStream;
      const listener: EventListener = () => {
        void this.serialize(() => this.handleStreamEnded(stream));
      };
      this.activeStreamInactiveListener = listener;
      stream.addEventListener?.("inactive", listener);
    }
  }

  private detachActiveMediaListeners(): void {
    try {
      if (this.activeTrackEndedListener !== null) this.activeTrack?.removeEventListener?.("ended", this.activeTrackEndedListener);
    } catch {
      // Best-effort listener cleanup.
    }
    try {
      if (this.activeStreamInactiveListener !== null) this.activeStream?.removeEventListener?.("inactive", this.activeStreamInactiveListener);
    } catch {
      // Best-effort listener cleanup.
    }
    this.activeTrackEndedListener = null;
    this.activeStreamInactiveListener = null;
  }

  private clearActiveReferences(): void {
    this.detachActiveMediaListeners();
    this.activeTrack = null;
    this.activeStream = null;
    this.originalTrack = null;
    this.sender = null;
  }

  private unsubscribeAll(): void {
    this.safeUnsubscribe(this.permissionUnsubscribe);
    this.safeUnsubscribe(this.targetUnsubscribe);
    this.safeUnsubscribe(this.streamUnsubscribe);
    this.permissionUnsubscribe = null;
    this.targetUnsubscribe = null;
    this.subscribedTargetAdapter = null;
    this.streamUnsubscribe = null;
  }

  private safeUnsubscribe(unsubscribe: Unsubscribe | null): void {
    try {
      unsubscribe?.();
    } catch {
      // A failed unsubscribe must not prevent remaining best-effort cleanup.
    }
  }

  private async restoreAfterFailedReplacement(): Promise<boolean> {
    const sender = this.sender;
    const adapter = this.adapter;
    const original = this.originalTrack;
    if (sender === null || adapter === null || !this.isSenderAvailable(adapter, sender)) {
      this.lastOriginalTrackAvailable = isLiveVideoTrack(original);
      this.status.reason = "SENDER_DISAPPEARED";
      this.clearActiveReferences();
      return false;
    }
    const restoreTrack = isLiveVideoTrack(original) ? original : null;
    try {
      await adapter.restoreVideoTrack(sender, restoreTrack);
      if (sender.track !== restoreTrack) throw new Error("restore-not-observed");
      this.lastOriginalTrackAvailable = restoreTrack !== null;
      this.clearActiveReferences();
      return true;
    } catch {
      try {
        await adapter.restoreVideoTrack(sender, null);
        if (sender.track !== null) throw new Error("detach-not-observed");
        this.lastOriginalTrackAvailable = isLiveVideoTrack(original);
        this.clearActiveReferences();
        return true;
      } catch {
        // Keep the sender and candidate track references so disable()/destroy() can retry.
        return false;
      }
    }
  }

  private isSenderAvailable(adapter: TargetAdapter | null, sender: CameraVideoSender): boolean {
    if (adapter === null) return false;
    try {
      return adapter.isSenderAvailable?.(sender) ?? true;
    } catch {
      return false;
    }
  }

  private isTargetConnected(adapter: TargetAdapter | null): boolean {
    if (adapter === null) return false;
    try {
      return adapter.isConnected?.() !== false;
    } catch {
      return false;
    }
  }

  private getNormalizedCurrentOrigin(): string | null {
    try {
      return normalizeWebOrigin(this.dependencies.getCurrentOrigin());
    } catch {
      return null;
    }
  }

  private async revalidateActivation(origin: string): Promise<boolean> {
    const currentOrigin = this.getNormalizedCurrentOrigin();
    if (currentOrigin !== origin) {
      this.setAdapter(null);
      this.status = {
        ...this.status,
        state: "BLOCKED",
        origin: currentOrigin,
        supported: false,
        permission: "unknown",
        reason: "PAGE_NAVIGATED",
      };
      this.emit("TARGET_DISCONNECTED", { lifecycle: "navigation" });
      return false;
    }

    const permission = await this.safeContains(origin);
    if (permission === "granted") {
      this.status.permission = "granted";
      return true;
    }
    const wasGranted = this.status.permission === "granted";
    this.status.permission = permission === "required" ? (wasGranted ? "revoked" : "required") : "unavailable";
    this.status.state = "BLOCKED";
    this.status.reason = permission === "unavailable" ? "PERMISSION_UNAVAILABLE"
      : wasGranted ? "PERMISSION_REVOKED" : "PERMISSION_REQUIRED";
    this.emit("INTEGRATION_ERROR", { operation: "activation-revalidation" });
    return false;
  }

  private async safeGetStream(): Promise<CameraMediaStream | null> {
    try {
      return await this.dependencies.streams.getActiveStream();
    } catch {
      return null;
    }
  }

  private async safeContains(origin: string): Promise<"granted" | "required" | "unavailable"> {
    try {
      return await this.dependencies.permissions.contains(origin);
    } catch {
      return "unavailable";
    }
  }

  private fail(reason: string, details: Readonly<Record<string, string | number | boolean | null>> = {}): CameraIntegrationStatus {
    this.status.state = "ERROR";
    this.status.reason = reason;
    this.status.capcamActive = this.sender !== null && this.activeTrack !== null && this.sender.track === this.activeTrack;
    this.emit("INTEGRATION_ERROR", details);
    return this.getStatus();
  }

  private publishStatus(): void {
    const snapshot = this.getStatus();
    for (const listener of this.statusListeners) {
      try {
        listener(snapshot);
      } catch {
        // Status observers cannot disrupt lifecycle cleanup.
      }
    }
  }

  private emit(
    event: CameraIntegrationDiagnosticName,
    details: Readonly<Record<string, string | number | boolean | null>> = {},
  ): void {
    const diagnostic: CameraIntegrationDiagnostic = {
      event,
      occurredAt: this.now(),
      origin: this.status.origin,
      state: this.status.state,
      permission: this.status.permission,
      reason: this.status.reason,
      ...(Object.keys(details).length === 0 ? {} : { details: { ...details } }),
    };
    try {
      this.diagnostics(diagnostic);
    } catch {
      // Diagnostics are best-effort and must not affect track restoration/cleanup.
    }
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.lifecycleQueue.then(operation, operation);
    const publishedTask = task.then(
      (result) => {
        this.publishStatus();
        return result;
      },
      (error: unknown) => {
        this.publishStatus();
        throw error;
      },
    );
    this.lifecycleQueue = publishedTask.then(() => undefined, () => undefined);
    return publishedTask;
  }
}

