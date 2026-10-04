function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type RuntimeState =
  | "created"
  | "initializing"
  | "ready"
  | "active"
  | "stopping"
  | "stopped"
  | "resetting"
  | "error";

export type RuntimeSubsystemState = "created" | "initializing" | "ready" | "stopping" | "stopped" | "error";

export interface SerializedRuntimeError {
  code: string;
  message: string;
  details?: Readonly<Record<string, unknown>>;
}

export interface RuntimeStateSnapshot {
  runtimeSessionId: string;
  state: RuntimeState;
  changedAt: number;
  initializedAt: number | null;
  uptimeMs: number | null;
  lastError: SerializedRuntimeError | null;
}

export interface RuntimeDiagnostics extends RuntimeStateSnapshot {
  activeMediaCount: number;
  activePlaybackCount: number;
  activeStreamCount: number;
  rendererActive: boolean;
  subsystems: {
    mediaEngine: RuntimeSubsystemState;
    playbackEngine: RuntimeSubsystemState;
    canvasRenderer: RuntimeSubsystemState;
    streamManager: RuntimeSubsystemState;
  };
}

export interface RuntimePingResponse {
  runtimeSessionId: string;
  state: RuntimeState;
  pongAt: number;
}

export interface RuntimeTransition {
  from: RuntimeState;
  to: RuntimeState;
  at: number;
}

const RUNTIME_STATES: readonly RuntimeState[] = [
  "created", "initializing", "ready", "active", "stopping", "stopped", "resetting", "error",
];
const SUBSYSTEM_STATES: readonly RuntimeSubsystemState[] = [
  "created", "initializing", "ready", "stopping", "stopped", "error",
];

export function generateRuntimeSessionId(): string {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === "function") return `runtime_${cryptoApi.randomUUID()}`;
  if (typeof cryptoApi?.getRandomValues === "function") {
    const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
    return `runtime_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  }
  return `runtime_${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

export function isRuntimeSessionId(value: unknown): value is string {
  return typeof value === "string" && /^runtime_[A-Za-z0-9-]{8,100}$/.test(value);
}

export function isRuntimeState(value: unknown): value is RuntimeState {
  return typeof value === "string" && RUNTIME_STATES.includes(value as RuntimeState);
}

function isFiniteOrNull(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

function isSerializedRuntimeError(value: unknown): value is SerializedRuntimeError | null {
  if (value === null) return true;
  if (!isPlainRecord(value) || typeof value.code !== "string" || value.code.length === 0 ||
    typeof value.message !== "string" || value.message.length === 0) return false;
  if (Object.hasOwn(value, "details") && !isPlainRecord(value.details)) return false;
  return Object.keys(value).every((key) => ["code", "message", "details"].includes(key));
}

export function isRuntimeStateSnapshot(value: unknown): value is RuntimeStateSnapshot {
  return isPlainRecord(value) && isRuntimeSessionId(value.runtimeSessionId) && isRuntimeState(value.state) &&
    typeof value.changedAt === "number" && Number.isFinite(value.changedAt) &&
    isFiniteOrNull(value.initializedAt) && isFiniteOrNull(value.uptimeMs) &&
    (value.uptimeMs === null || value.uptimeMs >= 0) && isSerializedRuntimeError(value.lastError) &&
    Object.keys(value).length === 6 &&
    Object.keys(value).every((key) => ["runtimeSessionId", "state", "changedAt", "initializedAt", "uptimeMs", "lastError"].includes(key));
}

export function isRuntimeDiagnostics(value: unknown): value is RuntimeDiagnostics {
  if (!isPlainRecord(value) || !isRuntimeStateSnapshot({
    runtimeSessionId: value.runtimeSessionId,
    state: value.state,
    changedAt: value.changedAt,
    initializedAt: value.initializedAt,
    uptimeMs: value.uptimeMs,
    lastError: value.lastError,
  })) return false;
  const subsystems = value.subsystems;
  if (!isPlainRecord(subsystems) || Object.keys(subsystems).length !== 4 ||
    !Object.keys(subsystems).every((key) => ["mediaEngine", "playbackEngine", "canvasRenderer", "streamManager"].includes(key)) ||
    !SUBSYSTEM_STATES.includes(subsystems.mediaEngine as RuntimeSubsystemState) ||
    !SUBSYSTEM_STATES.includes(subsystems.playbackEngine as RuntimeSubsystemState) ||
    !SUBSYSTEM_STATES.includes(subsystems.canvasRenderer as RuntimeSubsystemState) ||
    !SUBSYSTEM_STATES.includes(subsystems.streamManager as RuntimeSubsystemState)) return false;
  return Number.isInteger(value.activeMediaCount) && (value.activeMediaCount as number) >= 0 &&
    Number.isInteger(value.activePlaybackCount) && (value.activePlaybackCount as number) >= 0 &&
    Number.isInteger(value.activeStreamCount) && (value.activeStreamCount as number) >= 0 &&
    typeof value.rendererActive === "boolean" && Object.keys(value).length === 11 &&
    Object.keys(value).every((key) => [
      "runtimeSessionId", "state", "changedAt", "initializedAt", "uptimeMs", "lastError",
      "activeMediaCount", "activePlaybackCount", "activeStreamCount", "rendererActive", "subsystems",
    ].includes(key));
}

export function isRuntimePingResponse(value: unknown): value is RuntimePingResponse {
  return isPlainRecord(value) && isRuntimeSessionId(value.runtimeSessionId) && isRuntimeState(value.state) &&
    typeof value.pongAt === "number" && Number.isFinite(value.pongAt) && Object.keys(value).length === 3 &&
    Object.keys(value).every((key) => ["runtimeSessionId", "state", "pongAt"].includes(key));
}

export function isRuntimeTransition(value: unknown): value is RuntimeTransition {
  return isPlainRecord(value) && isRuntimeState(value.from) && isRuntimeState(value.to) &&
    typeof value.at === "number" && Number.isFinite(value.at) && Object.keys(value).length === 3 &&
    Object.keys(value).every((key) => ["from", "to", "at"].includes(key));
}
