import { normalizeWebOrigin } from "./origin";

export const CAMERA_INTEGRATION_STATES = [
  "IDLE",
  "DETECTING",
  "READY",
  "TARGET_REGISTERED",
  "SOURCE_READY",
  "ACTIVE",
  "RESTORING",
  "STOPPING",
  "ERROR",
  "UNSUPPORTED",
  "BLOCKED",
  "BLOCKED_PHASE_06_VERIFICATION",
] as const;

export type CameraIntegrationState = (typeof CAMERA_INTEGRATION_STATES)[number];

export type PermissionState = "unknown" | "required" | "granted" | "denied" | "revoked" | "unavailable";

export interface CameraIntegrationStatus {
  state: CameraIntegrationState;
  origin: string | null;
  supported: boolean;
  permission: PermissionState;
  capcamActive: boolean;
  originalTrackAvailable: boolean;
  activeTrackAvailable: boolean;
  reason: string | null;
}

const PERMISSION_STATES: readonly PermissionState[] = ["unknown", "required", "granted", "denied", "revoked", "unavailable"];

export function isCameraIntegrationStatus(value: unknown): value is CameraIntegrationStatus {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.state === "string" && CAMERA_INTEGRATION_STATES.includes(record.state as CameraIntegrationState) &&
    (record.origin === null || (typeof record.origin === "string" && normalizeWebOrigin(record.origin) === record.origin)) &&
    typeof record.supported === "boolean" && typeof record.permission === "string" && PERMISSION_STATES.includes(record.permission as PermissionState) &&
    typeof record.capcamActive === "boolean" && typeof record.originalTrackAvailable === "boolean" &&
    typeof record.activeTrackAvailable === "boolean" && (record.reason === null || typeof record.reason === "string") &&
    Object.keys(record).length === 8 && Object.keys(record).every((key) => [
      "state", "origin", "supported", "permission", "capcamActive", "originalTrackAvailable", "activeTrackAvailable", "reason",
    ].includes(key));
}

export type CameraIntegrationDiagnosticName =
  | "TARGET_DETECTED"
  | "TARGET_UNSUPPORTED"
  | "PERMISSION_REQUIRED"
  | "PERMISSION_GRANTED"
  | "INTEGRATION_READY"
  | "INTEGRATION_ENABLED"
  | "TRACK_REPLACED"
  | "TRACK_RESTORED"
  | "SOURCE_CHANGED"
  | "TRACK_ENDED"
  | "TARGET_DISCONNECTED"
  | "INTEGRATION_DISABLED"
  | "INTEGRATION_ERROR"
  | "BLOCKED_PHASE_06_VERIFICATION";

export type DiagnosticValue = string | number | boolean | null;

export interface CameraIntegrationDiagnostic {
  event: CameraIntegrationDiagnosticName;
  occurredAt: number;
  origin: string | null;
  state: CameraIntegrationState;
  permission: PermissionState;
  reason: string | null;
  details?: Readonly<Record<string, DiagnosticValue>>;
}

export type CameraIntegrationDiagnosticSink = (diagnostic: CameraIntegrationDiagnostic) => void;
export type Unsubscribe = () => void;

/** Minimal in-context view of a video track; never serialize this object. */
export interface CameraVideoTrack {
  readonly kind: string;
  readonly readyState: string;
  addEventListener?(type: "ended", listener: EventListener): void;
  removeEventListener?(type: "ended", listener: EventListener): void;
}

/** A MediaStream-like value supplied by an already-authorized CapCam stream provider. */
export interface CameraMediaStream {
  readonly active: boolean;
  getVideoTracks(): CameraVideoTrack[];
  addEventListener?(type: "inactive", listener: EventListener): void;
  removeEventListener?(type: "inactive", listener: EventListener): void;
}

/** Adapter around an existing video RTCRtpSender. */
export interface CameraVideoSender {
  readonly track: CameraVideoTrack | null;
  replaceTrack(track: CameraVideoTrack | null): Promise<void>;
}

export type TargetUnsupportedReason =
  | "UNSUPPORTED_ORIGIN"
  | "NO_WEBRTC_CONNECTION"
  | "NO_VIDEO_SENDER"
  | "AMBIGUOUS_VIDEO_SENDERS"
  | "TARGET_WORKFLOW_UNSUPPORTED";

export interface TargetDetection {
  supported: boolean;
  hasWebRtcWorkflow: boolean;
  hasCameraWorkflow: boolean;
  reasonCode?: TargetUnsupportedReason;
}

export type TargetLifecycleEvent = "target-disconnected" | "pagehide" | "navigation" | "extension-restart";

/** Target-specific behavior is isolated here; no website selectors belong in the media engine. */
export interface TargetAdapter {
  detect(origin: string): Promise<TargetDetection>;
  findVideoSender(): Promise<CameraVideoSender | null>;
  replaceVideoTrack(sender: CameraVideoSender, track: CameraVideoTrack): Promise<void>;
  restoreVideoTrack(sender: CameraVideoSender, track: CameraVideoTrack | null): Promise<void>;
  isSenderAvailable?(sender: CameraVideoSender): boolean;
  isConnected?(): boolean;
  subscribeLifecycle?(listener: (event: TargetLifecycleEvent) => void): Unsubscribe;
  cleanup?(): Promise<void> | void;
}

export interface TargetAdapterResolver {
  resolve(origin: string): TargetAdapter | null;
}

export type CapCamStreamEvent =
  | { type: "source-changed"; stream: CameraMediaStream }
  | { type: "stream-ended" };

export interface CapCamStreamProvider {
  getActiveStream(): Promise<CameraMediaStream | null>;
  subscribe?(listener: (event: CapCamStreamEvent) => void): Unsubscribe;
}

export type PermissionQueryResult = "granted" | "required" | "unavailable";
export type PermissionRequestResult = "granted" | "denied" | "unavailable";

export interface OriginPermissionBroker {
  contains(origin: string): Promise<PermissionQueryResult>;
  request(origin: string): Promise<PermissionRequestResult>;
  subscribeRevoked?(listener: (origin: string) => void): Unsubscribe;
}
