export type CameraIntegrationState =
  | "OFF"
  | "INITIALIZING"
  | "READY"
  | "CONNECTING"
  | "ACTIVE"
  | "STOPPING"
  | "ERROR"
  | "TARGET_UNSUPPORTED"
  | "DISCONNECTED";

export interface CameraApiSupport {
  getUserMedia: boolean;
  mediaStream: boolean;
  peerConnection: boolean;
  replaceTrack: boolean;
}

export interface CameraIntegrationStatus {
  state: CameraIntegrationState;
  supported: boolean | null;
  activeTrackId: string | null;
  activeTrackReadyState: string | null;
  error: string | null;
}

export interface IntegrationTrack {
  readonly id: string;
  readonly kind: string;
  readonly readyState: string;
}

export interface ReplaceableVideoSender<TTrack extends IntegrationTrack> {
  readonly track: TTrack | null;
  replaceTrack(track: TTrack | null): Promise<void>;
}

export type CameraIntegrationDiagnosticEvent =
  | "target.detected"
  | "integration.initialized"
  | "integration.unsupported"
  | "track.attached"
  | "camera.replacement.active"
  | "track.replaced"
  | "integration.disabled"
  | "integration.destroyed"
  | "integration.error";

export interface CameraIntegrationDiagnostic {
  event: CameraIntegrationDiagnosticEvent;
  details: Record<string, unknown>;
}

export type CameraApiSupportProvider = () => CameraApiSupport;
export type CameraIntegrationDiagnosticSink = (diagnostic: CameraIntegrationDiagnostic) => void;

export function detectBrowserCameraApis(): CameraApiSupport {
  const mediaDevices = typeof navigator === "undefined" ? undefined : navigator.mediaDevices;
  const senderPrototype = typeof RTCRtpSender === "undefined" ? undefined : RTCRtpSender.prototype;
  return {
    getUserMedia: typeof mediaDevices?.getUserMedia === "function",
    mediaStream: typeof MediaStream === "function",
    peerConnection: typeof RTCPeerConnection === "function",
    replaceTrack: typeof senderPrototype?.replaceTrack === "function",
  };
}

export function isCameraIntegrationSupported(support: CameraApiSupport): boolean {
  return support.getUserMedia && support.mediaStream && support.peerConnection && support.replaceTrack;
}

function describeUnsupported(support: CameraApiSupport): string {
  const missing = Object.entries(support)
    .filter(([, available]) => !available)
    .map(([name]) => name);
  return missing.length === 0 ? "The controlled page does not support the required camera APIs." :
    `The controlled page is missing required camera APIs: ${missing.join(", ")}.`;
}

export class CameraIntegration<TTrack extends IntegrationTrack> {
  private state: CameraIntegrationState = "OFF";
  private supported: boolean | null = null;
  private error: string | null = null;
  private sender: ReplaceableVideoSender<TTrack> | null = null;
  private originalTrack: TTrack | null = null;
  private activeTrack: TTrack | null = null;
  private lifecycleQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly getApiSupport: CameraApiSupportProvider = detectBrowserCameraApis,
    private readonly report: CameraIntegrationDiagnosticSink = () => undefined,
  ) {}

  detect(): CameraApiSupport {
    const support = this.getApiSupport();
    this.report({
      event: "target.detected",
      details: { context: "controlled-local-page", support: { ...support }, supported: isCameraIntegrationSupported(support) },
    });
    return { ...support };
  }

  initialize(): Promise<CameraIntegrationStatus> {
    return this.serialize(() => this.initializeInternal());
  }

  enable(sender: ReplaceableVideoSender<TTrack>, track: TTrack): Promise<CameraIntegrationStatus> {
    return this.serialize(() => this.enableInternal(sender, track));
  }

  replaceTrack(track: TTrack): Promise<CameraIntegrationStatus> {
    return this.serialize(() => this.replaceTrackInternal(track));
  }

  disable(): Promise<CameraIntegrationStatus> {
    return this.serialize(() => this.disableInternal());
  }

  handleTrackEnded(trackId: string): Promise<CameraIntegrationStatus> {
    return this.serialize(async () => {
      if (this.state !== "ACTIVE" || this.activeTrack?.id !== trackId) return this.getStatus();
      this.state = "DISCONNECTED";
      this.error = "The active CapCam video track ended unexpectedly.";
      this.report({ event: "integration.error", details: { ...this.statusDetails(), operation: "track-ended" } });
      return this.disableInternal();
    });
  }

  destroy(): Promise<CameraIntegrationStatus> {
    return this.serialize(async () => {
      let cleanupError: unknown;
      try {
        await this.disableInternal();
      } catch (error) {
        cleanupError = error;
      }
      this.sender = null;
      this.originalTrack = null;
      this.activeTrack = null;
      if (cleanupError === undefined) {
        this.state = "OFF";
        this.error = null;
      } else {
        this.state = "ERROR";
        this.error = this.errorText(cleanupError);
      }
      this.report({ event: "integration.destroyed", details: this.statusDetails() });
      return this.getStatus();
    });
  }

  getStatus(): CameraIntegrationStatus {
    return {
      state: this.state,
      supported: this.supported,
      activeTrackId: this.activeTrack?.id ?? null,
      activeTrackReadyState: this.activeTrack?.readyState ?? null,
      error: this.error,
    };
  }

  private async initializeInternal(): Promise<CameraIntegrationStatus> {
    if (this.state === "ACTIVE" || this.state === "READY") return this.getStatus();
    this.state = "INITIALIZING";
    this.error = null;
    const support = this.getApiSupport();
    this.supported = isCameraIntegrationSupported(support);
    if (!this.supported) {
      this.state = "TARGET_UNSUPPORTED";
      this.error = describeUnsupported(support);
      this.report({ event: "integration.unsupported", details: { ...this.statusDetails(), support } });
      return this.getStatus();
    }
    this.state = "READY";
    this.report({ event: "integration.initialized", details: this.statusDetails() });
    return this.getStatus();
  }

  private async enableInternal(sender: ReplaceableVideoSender<TTrack>, track: TTrack): Promise<CameraIntegrationStatus> {
    if (this.state === "ACTIVE") {
      if (sender !== this.sender) throw new Error("An active integration cannot be rebound to a different sender.");
      return this.replaceTrackInternal(track);
    }
    if (this.state !== "READY") await this.initializeInternal();
    if (this.state === "TARGET_UNSUPPORTED") throw new Error(this.error ?? "The controlled page does not support camera integration.");
    if (this.state !== "READY") throw new Error(`Cannot enable the camera integration from ${this.state}.`);
    this.assertVideoTrack(track);
    if (sender.track !== null && sender.track.kind !== "video") {
      this.state = "ERROR";
      this.error = "The target sender is not a video sender.";
      this.report({ event: "integration.error", details: this.statusDetails() });
      throw new Error(this.error);
    }

    this.sender = sender;
    this.originalTrack = sender.track;
    this.state = "CONNECTING";
    this.error = null;
    try {
      await sender.replaceTrack(track);
      this.assertSenderUses(sender, track);
      this.activeTrack = track;
      this.state = "ACTIVE";
      this.report({ event: "track.attached", details: this.statusDetails() });
      this.report({ event: "camera.replacement.active", details: this.statusDetails() });
      return this.getStatus();
    } catch (error) {
      const failure = this.errorText(error);
      await this.restoreSenderBestEffort(sender, this.originalTrack);
      this.sender = null;
      this.originalTrack = null;
      this.activeTrack = null;
      this.state = "ERROR";
      this.error = failure;
      this.report({ event: "integration.error", details: this.statusDetails() });
      throw error;
    }
  }

  private async replaceTrackInternal(track: TTrack): Promise<CameraIntegrationStatus> {
    if (this.state !== "ACTIVE" || this.sender === null || this.activeTrack === null) {
      throw new Error("Enable the camera integration before replacing its track.");
    }
    this.assertVideoTrack(track);
    if (track.id === this.activeTrack.id) return this.getStatus();

    const sender = this.sender;
    const previousTrack = this.activeTrack;
    try {
      await sender.replaceTrack(track);
      this.assertSenderUses(sender, track);
      this.activeTrack = track;
      this.error = null;
      this.report({
        event: "track.replaced",
        details: { ...this.statusDetails(), previousTrackId: previousTrack.id },
      });
      return this.getStatus();
    } catch (error) {
      this.error = this.errorText(error);
      this.report({
        event: "integration.error",
        details: { ...this.statusDetails(), operation: "replaceTrack", previousTrackId: previousTrack.id },
      });
      throw error;
    }
  }

  private async disableInternal(): Promise<CameraIntegrationStatus> {
    if (this.state === "OFF") return this.getStatus();
    if (this.state === "READY" || this.state === "TARGET_UNSUPPORTED") {
      this.state = "OFF";
      this.error = null;
      return this.getStatus();
    }

    this.state = "STOPPING";
    const sender = this.sender;
    const restoreTrack = this.originalTrack?.kind === "video" && this.originalTrack.readyState === "live"
      ? this.originalTrack
      : null;
    try {
      if (sender !== null) {
        await sender.replaceTrack(restoreTrack);
        if (restoreTrack !== null && sender.track?.id !== restoreTrack.id) {
          throw new Error("The sender did not restore the original live video track.");
        }
        if (restoreTrack === null && sender.track !== null) {
          throw new Error("The sender did not detach the CapCam track.");
        }
      }
      this.error = null;
    } catch (error) {
      const restoreError = this.errorText(error);
      try {
        if (sender !== null) await sender.replaceTrack(null);
        this.error = `The original camera track could not be restored; the video sender was detached instead: ${restoreError}`;
      } catch (detachError) {
        this.state = "ERROR";
        this.error = `Unable to restore or detach the video sender: ${this.errorText(detachError)}`;
        this.report({ event: "integration.error", details: this.statusDetails() });
        throw new Error(this.error);
      }
    }

    this.sender = null;
    this.originalTrack = null;
    this.activeTrack = null;
    this.state = "OFF";
    this.report({ event: "integration.disabled", details: this.statusDetails() });
    return this.getStatus();
  }

  private assertVideoTrack(track: TTrack): void {
    if (track.kind !== "video") throw new Error("The CapCam source must be a video track.");
    if (track.readyState !== "live") throw new Error("The CapCam video track is not live.");
  }

  private assertSenderUses(sender: ReplaceableVideoSender<TTrack>, track: TTrack): void {
    if (track.readyState !== "live") throw new Error("The CapCam video track ended during replacement.");
    if (sender.track?.kind !== "video" || sender.track.id !== track.id) {
      throw new Error("replaceTrack resolved, but the sender does not expose the requested live video track.");
    }
  }

  private async restoreSenderBestEffort(sender: ReplaceableVideoSender<TTrack>, track: TTrack | null): Promise<void> {
    try {
      const restore = track?.kind === "video" && track.readyState === "live" ? track : null;
      await sender.replaceTrack(restore);
    } catch {
      try {
        await sender.replaceTrack(null);
      } catch {
        // The caller reports the original failure; destruction/peer close remains the final cleanup boundary.
      }
    }
  }

  private statusDetails(): Record<string, unknown> {
    return {
      state: this.state,
      supported: this.supported,
      activeTrackId: this.activeTrack?.id ?? null,
      activeTrackReadyState: this.activeTrack?.readyState ?? null,
      error: this.error,
    };
  }

  private errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.lifecycleQueue.then(operation, operation);
    this.lifecycleQueue = task.then(() => undefined, () => undefined);
    return task;
  }
}
