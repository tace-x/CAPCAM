import {
  CameraIntegrationCore,
  type CameraIntegrationDependencies,
  type CameraSource,
  type Phase06Verification,
} from "./camera-integration-core";
import { normalizeWebOrigin } from "./origin";
import { ExactOriginTargetRegistry } from "./target-registry";
import type {
  CameraIntegrationDiagnosticSink,
  CameraIntegrationStatus,
  CameraMediaStream,
  CameraVideoTrack,
  CapCamStreamEvent,
  CapCamStreamProvider,
  OriginPermissionBroker,
  TargetAdapter,
  TargetLifecycleEvent,
  Unsubscribe,
} from "./types";
import {
  GenericWebRtcTargetAdapter,
  WebRtcPeerConnectionRegistry,
  type WebRtcPeerConnectionPort,
} from "./web-rtc-target-adapter";

/** Resolves the CapCam source inside the target context; MediaStream/Track never enter the handoff. */
export interface CameraSourceSelector {
  select(mediaId: string): Promise<CameraSource | null>;
}

export interface CameraIntegrationAgent {
  getStatus(): CameraIntegrationStatus;
  detect(): Promise<CameraIntegrationStatus>;
  enable(source?: CameraSource): Promise<CameraIntegrationStatus>;
  disable(): Promise<CameraIntegrationStatus>;
  switchSource(mediaId: string): Promise<CameraIntegrationStatus>;
  handleTargetLifecycle(event: TargetLifecycleEvent): Promise<CameraIntegrationStatus>;
  subscribeStatus(listener: (status: CameraIntegrationStatus) => void): Unsubscribe;
  destroy(): Promise<CameraIntegrationStatus>;
}

/** In-memory CapCam stream provider for local and test contexts. */
export class LocalStreamProvider implements CapCamStreamProvider {
  private currentStream: CameraMediaStream | null = null;
  private readonly listeners = new Set<(event: CapCamStreamEvent) => void>();

  constructor(initialStream: CameraMediaStream | null = null) {
    this.currentStream = initialStream;
  }

  setStream(stream: CameraMediaStream | null): void {
    this.currentStream = stream;
    if (stream !== null) {
      this.notify({ type: "source-changed", stream });
    } else {
      this.notify({ type: "stream-ended" });
    }
  }

  async getActiveStream(): Promise<CameraMediaStream | null> {
    return this.currentStream;
  }

  subscribe(listener: (event: CapCamStreamEvent) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(event: CapCamStreamEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Observers must not suppress notifications.
      }
    }
  }
}

/**
 * Target-context implementation of the stable agent API. Source selection and all
 * browser media objects remain local to this context; the handoff carries IDs/status only.
 */
export class LocalCameraIntegrationAgent implements CameraIntegrationAgent {
  constructor(
    private readonly integration: CameraIntegrationCore,
    private readonly sources?: CameraSourceSelector,
    private readonly connections?: WebRtcPeerConnectionRegistry,
    private readonly adapter?: TargetAdapter,
    private readonly streamProvider?: CapCamStreamProvider,
  ) {}

  getStatus(): CameraIntegrationStatus {
    return this.integration.getStatus();
  }

  detect(): Promise<CameraIntegrationStatus> {
    return this.integration.detect();
  }

  enable(source?: CameraSource): Promise<CameraIntegrationStatus> {
    return this.integration.enable(source);
  }

  disable(): Promise<CameraIntegrationStatus> {
    return this.integration.disable();
  }

  replaceTrack(source: CameraSource): Promise<CameraIntegrationStatus> {
    return this.integration.replaceTrack(source);
  }

  /**
   * Explicitly registers a controlled WebRTC peer connection.
   * Never scans the page or patches global constructors.
   */
  registerTarget(connection: WebRtcPeerConnectionPort | RTCPeerConnection): Unsubscribe {
    if (this.connections === undefined) {
      throw new Error("Target registration requires an active WebRtcPeerConnectionRegistry.");
    }
    const unsubscribe = typeof (connection as unknown as WebRtcPeerConnectionPort).getSenders === "function"
      ? this.connections.register(connection as WebRtcPeerConnectionPort)
      : this.connections.registerNative(connection as RTCPeerConnection);
    return () => {
      unsubscribe();
    };
  }

  unregisterTarget(connection: WebRtcPeerConnectionPort | RTCPeerConnection): void {
    if (this.connections === undefined) return;
    if (typeof (connection as unknown as WebRtcPeerConnectionPort).getSenders === "function") {
      this.connections.unregister(connection as WebRtcPeerConnectionPort);
    } else {
      this.connections.unregisterNative(connection as RTCPeerConnection);
    }
  }

  getPeerConnectionState(): { isConnected: boolean; connectionCount: number } {
    return {
      isConnected: this.connections?.isConnected() ?? false,
      connectionCount: this.connections?.getConnections().length ?? 0,
    };
  }

  async getSenderState(): Promise<{ available: boolean; isVideo: boolean; trackReadyState: string | null }> {
    if (this.adapter === undefined) {
      return { available: false, isVideo: false, trackReadyState: null };
    }
    try {
      const sender = await this.adapter.findVideoSender();
      if (sender === null || (this.adapter.isSenderAvailable !== undefined && !this.adapter.isSenderAvailable(sender))) {
        return { available: false, isVideo: false, trackReadyState: null };
      }
      const track = sender.track;
      return {
        available: true,
        isVideo: track?.kind === "video",
        trackReadyState: track?.readyState ?? null,
      };
    } catch {
      return { available: false, isVideo: false, trackReadyState: null };
    }
  }

  /** Accepts an in-context MediaStream or video track handoff. */
  async acceptSource(source: CameraSource): Promise<CameraIntegrationStatus> {
    if (this.streamProvider instanceof LocalStreamProvider) {
      if (typeof (source as CameraMediaStream).getVideoTracks === "function") {
        this.streamProvider.setStream(source as CameraMediaStream);
      }
    }
    const current = this.getStatus();
    if (current.capcamActive) {
      return this.replaceTrack(source);
    }
    return current;
  }

  async switchSource(mediaId: string): Promise<CameraIntegrationStatus> {
    const selector = this.sources ?? { select: async () => null };
    let source: CameraSource | null;
    try {
      source = await selector.select(mediaId);
    } catch {
      return {
        ...this.integration.getStatus(),
        reason: "CAPCAM_SOURCE_SELECTION_FAILED",
      };
    }
    if (source === null) {
      return {
        ...this.integration.getStatus(),
        reason: "CAPCAM_SOURCE_UNAVAILABLE",
      };
    }
    return this.integration.replaceTrack(source);
  }

  handleTrackEnded(track: CameraVideoTrack): Promise<CameraIntegrationStatus> {
    return this.integration.handleTrackEnded(track);
  }

  handleTargetLifecycle(event: TargetLifecycleEvent): Promise<CameraIntegrationStatus> {
    return this.integration.handleTargetLifecycle(event);
  }

  subscribeStatus(listener: (status: CameraIntegrationStatus) => void): Unsubscribe {
    return this.integration.subscribeStatus(listener);
  }

  async destroy(): Promise<CameraIntegrationStatus> {
    const status = await this.integration.destroy();
    try {
      this.connections?.clear();
    } catch {
      // Clear connections best-effort.
    }
    if (this.streamProvider instanceof LocalStreamProvider) {
      this.streamProvider.setStream(null);
    }
    return status;
  }
}

export interface ControlledTargetAgentOptions {
  origin: string;
  connections?: WebRtcPeerConnectionRegistry;
  sources?: CameraSourceSelector;
  streamProvider?: LocalStreamProvider;
  permissionBroker?: OriginPermissionBroker;
  phase06Verified?: Phase06Verification;
  diagnostics?: CameraIntegrationDiagnosticSink;
  now?: () => number;
}

/**
 * Creates an operational LocalCameraIntegrationAgent configured for a controlled target context.
 * Enforces exact-origin matching and explicit peer connection registration.
 */
export function createControlledTargetAgent(
  options: ControlledTargetAgentOptions,
): LocalCameraIntegrationAgent {
  const normalizedOrigin = normalizeWebOrigin(options.origin);
  if (normalizedOrigin === null || normalizedOrigin !== options.origin) {
    throw new Error("Controlled target agent requires a normalized exact HTTP(S) origin.");
  }

  const connections = options.connections ?? new WebRtcPeerConnectionRegistry();
  const adapter = new GenericWebRtcTargetAdapter(options.origin, connections);
  const targets = new ExactOriginTargetRegistry([{ origin: options.origin, adapter }]);
  const permissions: OriginPermissionBroker = options.permissionBroker ?? {
    contains: async () => "granted",
    request: async () => "granted",
  };
  const streamProvider = options.streamProvider ?? new LocalStreamProvider();
  const dependencies: CameraIntegrationDependencies = {
    getCurrentOrigin: () => options.origin,
    targets,
    permissions,
    streams: streamProvider,
    ...(options.diagnostics !== undefined ? { diagnostics: options.diagnostics } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
  };
  const integration = new CameraIntegrationCore(
    dependencies,
    options.phase06Verified ?? (() => true),
  );

  return new LocalCameraIntegrationAgent(
    integration,
    options.sources,
    connections,
    adapter,
    streamProvider,
  );
}
