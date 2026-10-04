import { normalizeWebOrigin } from "./origin";
import type {
  CameraVideoSender,
  CameraVideoTrack,
  TargetAdapter,
  TargetDetection,
  Unsubscribe,
} from "./types";

export interface WebRtcSenderPort extends CameraVideoSender {}

export interface WebRtcPeerConnectionPort {
  readonly connectionState?: string;
  getSenders(): readonly WebRtcSenderPort[];
  addEventListener?(type: "connectionstatechange" | "signalingstatechange" | "negotiationneeded", listener: EventListener): void;
  removeEventListener?(type: "connectionstatechange" | "signalingstatechange" | "negotiationneeded", listener: EventListener): void;
}

interface RegisteredConnection {
  references: number;
  disconnectedTimer: ReturnType<typeof setTimeout> | null;
  unavailable: boolean;
  listener: EventListener;
}

/**
 * Explicit registry of RTCPeerConnections supplied by an approved target context.
 * It never patches global WebRTC constructors or discovers arbitrary page globals.
 */
export class WebRtcPeerConnectionRegistry {
  private readonly connections = new Map<WebRtcPeerConnectionPort, RegisteredConnection>();
  private readonly listeners = new Set<() => void>();

  constructor(private readonly disconnectGraceMs = 1800) {}

  register(connection: WebRtcPeerConnectionPort): Unsubscribe {
    const existing = this.connections.get(connection);
    if (existing !== undefined) {
      existing.references += 1;
      return () => this.unregister(connection);
    }

    const entry: RegisteredConnection = {
      references: 1,
      disconnectedTimer: null,
      unavailable: false,
      listener: () => this.handleConnectionChange(connection),
    };
    this.connections.set(connection, entry);
    connection.addEventListener?.("connectionstatechange", entry.listener);
    connection.addEventListener?.("signalingstatechange", entry.listener);
    connection.addEventListener?.("negotiationneeded", entry.listener);
    this.handleConnectionChange(connection);
    this.publish();
    return () => this.unregister(connection);
  }

  /** Convenience bridge for an actual native RTCPeerConnection. */
  registerNative(connection: RTCPeerConnection): Unsubscribe {
    return this.register(connection as unknown as WebRtcPeerConnectionPort);
  }

  getConnections(): readonly WebRtcPeerConnectionPort[] {
    return Array.from(this.connections.keys());
  }

  isUsable(connection: WebRtcPeerConnectionPort): boolean {
    const entry = this.connections.get(connection);
    if (entry === undefined || entry.unavailable) return false;
    try {
      return connection.connectionState !== "closed" && connection.connectionState !== "failed";
    } catch {
      return false;
    }
  }

  isConnected(): boolean {
    return Array.from(this.connections.keys()).some((connection) => this.isUsable(connection));
  }

  subscribe(listener: () => void): Unsubscribe {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  clear(): void {
    for (const [connection, entry] of this.connections) {
      this.clearTimer(entry);
      connection.removeEventListener?.("connectionstatechange", entry.listener);
      connection.removeEventListener?.("signalingstatechange", entry.listener);
      connection.removeEventListener?.("negotiationneeded", entry.listener);
    }
    this.connections.clear();
    this.publish();
  }

  unregister(connection: WebRtcPeerConnectionPort): void {
    const entry = this.connections.get(connection);
    if (entry === undefined) return;
    entry.references -= 1;
    if (entry.references > 0) return;
    this.clearTimer(entry);
    connection.removeEventListener?.("connectionstatechange", entry.listener);
    connection.removeEventListener?.("signalingstatechange", entry.listener);
    connection.removeEventListener?.("negotiationneeded", entry.listener);
    this.connections.delete(connection);
    this.publish();
  }

  /** Convenience unregister for native RTCPeerConnection. */
  unregisterNative(connection: RTCPeerConnection): void {
    this.unregister(connection as unknown as WebRtcPeerConnectionPort);
  }

  private handleConnectionChange(connection: WebRtcPeerConnectionPort): void {
    const entry = this.connections.get(connection);
    if (entry === undefined) return;
    let state: string | undefined;
    try {
      state = connection.connectionState;
    } catch {
      state = "closed";
    }

    if (state === "closed" || state === "failed") {
      this.clearTimer(entry);
      entry.unavailable = true;
      this.publish();
      return;
    }
    if (state === "disconnected") {
      if (entry.disconnectedTimer === null) {
        entry.disconnectedTimer = setTimeout(() => {
          entry.disconnectedTimer = null;
          try {
            entry.unavailable = connection.connectionState === "disconnected";
          } catch {
            entry.unavailable = true;
          }
          this.publish();
        }, this.disconnectGraceMs);
      }
      this.publish();
      return;
    }

    this.clearTimer(entry);
    entry.unavailable = false;
    this.publish();
  }

  private clearTimer(entry: RegisteredConnection): void {
    if (entry.disconnectedTimer === null) return;
    clearTimeout(entry.disconnectedTimer);
    entry.disconnectedTimer = null;
  }

  private publish(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // One lifecycle subscriber cannot suppress notifications to the others.
      }
    }
  }
}

export class WebRtcSenderDiscoveryError extends Error {
  readonly code = "AMBIGUOUS_VIDEO_SENDERS";

  constructor() {
    super("More than one live video sender is registered for this target context.");
    this.name = "WebRtcSenderDiscoveryError";
  }
}

interface SenderBinding {
  nativeSender: WebRtcSenderPort;
  connection: WebRtcPeerConnectionPort;
}

/** Generic WebRTC target adapter. It operates only on explicitly registered connections. */
export class GenericWebRtcTargetAdapter implements TargetAdapter {
  private senderBindings = new WeakMap<CameraVideoSender, SenderBinding>();
  private senderWrappers = new WeakMap<WebRtcSenderPort, CameraVideoSender>();

  constructor(
    private readonly exactOrigin: string,
    private readonly connections: WebRtcPeerConnectionRegistry,
  ) {
    const normalized = normalizeWebOrigin(exactOrigin);
    if (normalized === null || normalized !== exactOrigin) {
      throw new Error("WebRTC adapters require a normalized exact HTTP(S) origin.");
    }
  }

  async detect(origin: string): Promise<TargetDetection> {
    const selectedOrigin = normalizeWebOrigin(origin);
    if (selectedOrigin === null || selectedOrigin !== this.exactOrigin) {
      return {
        supported: false,
        hasWebRtcWorkflow: false,
        hasCameraWorkflow: false,
        reasonCode: "UNSUPPORTED_ORIGIN",
      };
    }

    const connectionCount = this.connections.getConnections().filter((connection) => this.connections.isUsable(connection)).length;
    if (connectionCount === 0) {
      return {
        supported: false,
        hasWebRtcWorkflow: false,
        hasCameraWorkflow: false,
        reasonCode: "NO_WEBRTC_CONNECTION",
      };
    }

    const senderCount = this.discoverLiveVideoSenders().length;
    if (senderCount === 0) {
      return {
        supported: false,
        hasWebRtcWorkflow: true,
        hasCameraWorkflow: false,
        reasonCode: "NO_VIDEO_SENDER",
      };
    }
    if (senderCount > 1) {
      return {
        supported: false,
        hasWebRtcWorkflow: true,
        hasCameraWorkflow: true,
        reasonCode: "AMBIGUOUS_VIDEO_SENDERS",
      };
    }
    return { supported: true, hasWebRtcWorkflow: true, hasCameraWorkflow: true };
  }

  async findVideoSender(): Promise<CameraVideoSender | null> {
    const candidates = this.discoverLiveVideoSenders();
    if (candidates.length > 1) throw new WebRtcSenderDiscoveryError();
    return candidates[0]?.sender ?? null;
  }

  async replaceVideoTrack(sender: CameraVideoSender, track: CameraVideoTrack): Promise<void> {
    if (track.kind !== "video" || track.readyState !== "live") {
      throw new Error("Only a live video track can replace a WebRTC sender track.");
    }
    if (!this.isSenderAvailable(sender)) throw new Error("The WebRTC video sender disappeared before replacement.");
    await sender.replaceTrack(track);
    if (sender.track !== track) throw new Error("The WebRTC sender did not confirm the replacement track.");
  }

  async restoreVideoTrack(sender: CameraVideoSender, track: CameraVideoTrack | null): Promise<void> {
    if (!this.isSenderAvailable(sender)) throw new Error("The WebRTC video sender disappeared before restoration.");
    if (track !== null && (track.kind !== "video" || track.readyState !== "live")) {
      throw new Error("The original WebRTC sender track is no longer a live video track.");
    }
    await sender.replaceTrack(track);
    if (sender.track !== track) throw new Error("The WebRTC sender did not confirm restoration.");
  }

  isSenderAvailable(sender: CameraVideoSender): boolean {
    const binding = this.senderBindings.get(sender);
    if (binding === undefined || !this.connections.isUsable(binding.connection)) return false;
    try {
      return binding.connection.getSenders().includes(binding.nativeSender);
    } catch {
      return false;
    }
  }

  isConnected(): boolean {
    return this.connections.isConnected();
  }

  subscribeLifecycle(listener: (event: "target-disconnected" | "pagehide" | "navigation" | "extension-restart") => void): Unsubscribe {
    let disconnected = false;
    return this.connections.subscribe(() => {
      const isDisconnected = !this.connections.isConnected() || this.discoverLiveVideoSenders().length === 0;
      if (isDisconnected && !disconnected) listener("target-disconnected");
      disconnected = isDisconnected;
    });
  }

  /** Detaches adapter-owned wrappers; it does not close peer connections or stop tracks. */
  cleanup(): void {
    this.senderBindings = new WeakMap<CameraVideoSender, SenderBinding>();
    this.senderWrappers = new WeakMap<WebRtcSenderPort, CameraVideoSender>();
  }

  private discoverLiveVideoSenders(): Array<{ sender: CameraVideoSender; binding: SenderBinding }> {
    const candidates: Array<{ sender: CameraVideoSender; binding: SenderBinding }> = [];
    const seen = new Set<WebRtcSenderPort>();

    for (const connection of this.connections.getConnections()) {
      if (!this.connections.isUsable(connection)) continue;
      let senders: readonly WebRtcSenderPort[];
      try {
        senders = connection.getSenders();
      } catch {
        continue;
      }
      for (const nativeSender of senders) {
        if (seen.has(nativeSender)) continue;
        seen.add(nativeSender);
        let track: CameraVideoTrack | null;
        try {
          track = nativeSender.track;
        } catch {
          continue;
        }
        if (track === null || track.kind !== "video" || track.readyState !== "live") continue;

        const sender = this.wrapSender(nativeSender, connection);
        const binding = this.senderBindings.get(sender);
        if (binding !== undefined) candidates.push({ sender, binding });
      }
    }
    return candidates;
  }

  private wrapSender(nativeSender: WebRtcSenderPort, connection: WebRtcPeerConnectionPort): CameraVideoSender {
    const existing = this.senderWrappers.get(nativeSender);
    if (existing !== undefined) return existing;
    const sender: CameraVideoSender = {
      get track() {
        return nativeSender.track;
      },
      replaceTrack: async (track) => nativeSender.replaceTrack(track),
    };
    this.senderWrappers.set(nativeSender, sender);
    this.senderBindings.set(sender, { nativeSender, connection });
    return sender;
  }
}
