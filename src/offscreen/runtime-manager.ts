import { CapCamError, toCapCamError } from "../shared/errors";
import { createEvent, type EventEnvelope } from "../messaging/events";
import { createLogger } from "../shared/logger";
import {
  generateRuntimeSessionId,
  type RuntimeDiagnostics,
  type RuntimePingResponse,
  type RuntimeState,
  type RuntimeStateSnapshot,
  type RuntimeSubsystemState,
  type SerializedRuntimeError,
} from "../shared/runtime-types";
import type { OffscreenRuntimeInfo } from "../shared/types";
import { MediaRuntime } from "./media-runtime";
import { transitionRuntimeState } from "./runtime-state";

const logger = createLogger("Runtime");
type EventPublisher = (event: EventEnvelope) => void;

export interface RuntimeManagerOptions {
  now?: () => number;
  createRuntimeSessionId?: () => string;
  publishEvent?: EventPublisher;
}

interface SubsystemStatuses {
  mediaEngine: RuntimeSubsystemState;
  playbackEngine: RuntimeSubsystemState;
  canvasRenderer: RuntimeSubsystemState;
  streamManager: RuntimeSubsystemState;
}

const INITIAL_SUBSYSTEM_STATES: SubsystemStatuses = {
  mediaEngine: "created",
  playbackEngine: "created",
  canvasRenderer: "created",
  streamManager: "created",
};

const SESSION_EXEMPT_COMMANDS = new Set([
  "runtime.initialize", "runtime.getState", "runtime.getDiagnostics", "runtime.ping",
  "offscreen.initialize", "offscreen.getStatus",
]);

function cloneError(error: RuntimeStateSnapshot["lastError"]): RuntimeStateSnapshot["lastError"] {
  return error === null ? null : {
    ...error,
    ...(error.details === undefined ? {} : { details: { ...error.details } }),
  };
}

function isCatastrophicFailure(error: unknown): boolean {
  const failure = toCapCamError(error);
  return failure.code === "CAPCAM_RUNTIME_ERROR" ||
    failure.code === "RUNTIME_INITIALIZATION_FAILED" ||
    failure.code === "RUNTIME_SHUTDOWN_FAILED";
}

export class RuntimeManager {
  private state: RuntimeState = "created";
  private changedAt: number;
  private initializedAt: number | null = null;
  private lastError: RuntimeStateSnapshot["lastError"] = null;
  private runtimeSessionId: string;
  private subsystemStates: SubsystemStatuses = { ...INITIAL_SUBSYSTEM_STATES };
  private lifecycleQueue: Promise<void> = Promise.resolve();
  private initialization: Promise<RuntimeStateSnapshot> | null = null;
  private activeOperations = 0;
  private operationsIdleWaiters: Array<() => void> = [];
  private readonly now: () => number;
  private readonly createSessionId: () => string;
  private readonly publishEvent?: EventPublisher;

  constructor(
    readonly mediaRuntime: MediaRuntime,
    options: RuntimeManagerOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.createSessionId = options.createRuntimeSessionId ?? generateRuntimeSessionId;
    this.runtimeSessionId = this.createSessionId();
    this.changedAt = this.now();
    if (options.publishEvent !== undefined) this.publishEvent = options.publishEvent;
  }

  initialize(): Promise<RuntimeStateSnapshot> {
    if (this.state === "ready" || this.state === "active") return Promise.resolve(this.getState());
    if (this.initialization !== null) return this.initialization;
    const pending = this.serializeLifecycle(() => this.initializeInternal(false)).finally(() => {
      if (this.initialization === pending) this.initialization = null;
    });
    this.initialization = pending;
    return pending;
  }

  shutdown(): Promise<RuntimeStateSnapshot> {
    return this.serializeLifecycle(() => this.shutdownInternal());
  }

  reset(): Promise<RuntimeStateSnapshot> {
    return this.serializeLifecycle(async () => {
      if (this.state === "stopping") {
        throw new CapCamError("RUNTIME_NOT_READY", "Runtime reset cannot begin while shutdown is in progress.");
      }
      this.transition("resetting");
      await this.waitForOperationsIdle();
      this.setSubsystemStatuses("stopping");
      try {
        await this.mediaRuntime.shutdown();
      } catch (error) {
        const failureInfo = this.serializeError(error);
        this.lastError = failureInfo;
        this.setSubsystemStatuses("error");
        this.transition("error");
        throw new CapCamError("RUNTIME_SHUTDOWN_FAILED", "Runtime reset could not release all resources.", {
          causeCode: failureInfo.code,
          reason: failureInfo.message,
        });
      }
      this.initializedAt = null;
      this.setSubsystemStatuses("stopped");
      this.runtimeSessionId = this.createSessionId();
      this.lastError = null;
      this.transition("initializing");
      return this.initializeFromCurrentState();
    });
  }

  getState(): RuntimeStateSnapshot {
    const uptimeMs = this.initializedAt === null ? null : Math.max(0, this.now() - this.initializedAt);
    return {
      runtimeSessionId: this.runtimeSessionId,
      state: this.state,
      changedAt: this.changedAt,
      initializedAt: this.initializedAt,
      uptimeMs,
      lastError: cloneError(this.lastError),
    };
  }

  getDiagnostics(): RuntimeDiagnostics {
    const snapshot = this.getState();
    return {
      ...snapshot,
      activeMediaCount: this.mediaRuntime.mediaEngine.list().length,
      activePlaybackCount: this.mediaRuntime.playback.getActiveCount(),
      activeStreamCount: this.mediaRuntime.streams.getActiveCount(),
      rendererActive: this.mediaRuntime.streams.isRendererActive(),
      subsystems: { ...this.subsystemStates },
    };
  }

  ping(): RuntimePingResponse {
    return {
      runtimeSessionId: this.runtimeSessionId,
      state: this.state,
      pongAt: this.now(),
    };
  }

  getOffscreenStatus(): OffscreenRuntimeInfo {
    const status: OffscreenRuntimeInfo["status"] =
      this.state === "created" || this.state === "stopped" ? "STOPPED"
        : this.state === "initializing" || this.state === "resetting" || this.state === "stopping" ? "STARTING"
        : this.state === "error" ? "ERROR"
        : "READY";
    return { status, initializedAt: this.initializedAt };
  }

  authorizeCommand(command: string, requestSessionId?: string): CapCamError | null {
    if (!SESSION_EXEMPT_COMMANDS.has(command) && requestSessionId !== this.runtimeSessionId) {
      return new CapCamError("RUNTIME_SESSION_MISMATCH", "The request belongs to a different runtime session.", {
        command,
        expectedRuntimeSessionId: this.runtimeSessionId,
        receivedRuntimeSessionId: requestSessionId ?? null,
      });
    }

    if (command.startsWith("runtime.") || command.startsWith("offscreen.")) return null;
    if (this.state === "resetting") return new CapCamError("RUNTIME_RESETTING", "Runtime is resetting.");
    if (this.state === "stopped" || this.state === "stopping") return new CapCamError("RUNTIME_STOPPED", "Runtime is stopped.");
    if (this.state !== "ready" && this.state !== "active") {
      return new CapCamError("RUNTIME_NOT_READY", "Runtime is not ready for subsystem commands.", { state: this.state });
    }
    return null;
  }

  async runSubsystemOperation<T>(operation: () => T | Promise<T>): Promise<T> {
    const stateError = this.authorizeSubsystemOperation();
    if (stateError !== null) throw stateError;
    this.activeOperations += 1;
    let result!: T;
    let operationError: unknown;
    let failed = false;
    try {
      result = await operation();
    } catch (error) {
      failed = true;
      operationError = error;
      const failureInfo = this.serializeError(error);
      this.lastError = failureInfo;
      logger.warn("Subsystem command failed.", { code: failureInfo.code, state: this.state });
    } finally {
      this.activeOperations -= 1;
      if (this.activeOperations === 0) {
        for (const resolve of this.operationsIdleWaiters.splice(0)) resolve();
      }
    }

    if (failed) {
      if (isCatastrophicFailure(operationError)) await this.failRuntime(operationError);
      throw operationError;
    }
    this.syncActivityState();
    return result;
  }

  /** Called for native playback/stream lifecycle changes that happen outside a command response. */
  observeSubsystemActivity(): void {
    if (this.state !== "ready" && this.state !== "active") return;
    void this.serializeLifecycle(async () => {
      if (this.state === "ready" || this.state === "active") this.syncActivityState();
    });
  }

  private initializeInternal(rotateSession: boolean): Promise<RuntimeStateSnapshot> {
    if (this.state === "ready" || this.state === "active") return Promise.resolve(this.getState());
    if (this.state === "error") {
      return Promise.reject(new CapCamError("RUNTIME_NOT_READY", "Runtime is in error state; call runtime.reset to recover."));
    }
    if (this.state === "stopping" || this.state === "resetting") {
      return Promise.reject(new CapCamError("RUNTIME_NOT_READY", "Runtime lifecycle operation is already in progress.", { state: this.state }));
    }
    if (rotateSession || this.state === "stopped") this.runtimeSessionId = this.createSessionId();
    if (this.state !== "initializing") this.transition("initializing");
    return this.initializeFromCurrentState();
  }

  private async initializeFromCurrentState(): Promise<RuntimeStateSnapshot> {
    this.setSubsystemStatuses("initializing");
    logger.info("Runtime initializing.", { runtimeSessionId: this.runtimeSessionId });
    try {
      await this.mediaRuntime.initialize();
      this.subsystemStates.mediaEngine = "ready";
      logger.info("Media engine ready.");
      // Playback, canvas-pipeline factory, and stream manager are composed before initialize().
      // Canvas/stream DOM resources remain lazy until their first create command.
      this.subsystemStates.playbackEngine = "ready";
      logger.info("Playback engine ready.");
      this.subsystemStates.canvasRenderer = "ready";
      logger.info("Canvas pipeline ready.");
      this.subsystemStates.streamManager = "ready";
      logger.info("Stream manager ready.");
      this.initializedAt = this.now();
      this.lastError = null;
      this.transition("ready");
      this.syncActivityState();
      logger.info("Runtime ready.", { runtimeSessionId: this.runtimeSessionId });
      return this.getState();
    } catch (error) {
      let cleanupError: unknown;
      try {
        await this.mediaRuntime.shutdown();
      } catch (caught) {
        cleanupError = caught;
      }
      this.setSubsystemStatuses(cleanupError === undefined ? "stopped" : "error");
      this.initializedAt = null;
      const failure = toCapCamError(error);
      this.lastError = this.serializeError(cleanupError ?? error);
      this.transition("error");
      logger.error("Runtime initialization failed.", { code: failure.code, runtimeSessionId: this.runtimeSessionId });
      throw new CapCamError("RUNTIME_INITIALIZATION_FAILED", "Offscreen runtime initialization failed and partial resources were cleaned up.", {
        causeCode: failure.code,
        reason: failure.message,
        ...(cleanupError === undefined ? {} : { cleanupReason: toCapCamError(cleanupError).message }),
      });
    }
  }

  private async shutdownInternal(): Promise<RuntimeStateSnapshot> {
    if (this.state === "stopped") return this.getState();
    if (this.state === "stopping") return this.getState();
    this.transition("stopping");
    await this.waitForOperationsIdle();
    this.setSubsystemStatuses("stopping");
    try {
      // MediaRuntime enforces reverse dependency cleanup: playback → stream/track/scheduler/canvas → media.
      await this.mediaRuntime.shutdown();
      this.initializedAt = null;
      this.lastError = null;
      this.setSubsystemStatuses("stopped");
      this.transition("stopped");
      logger.info("Runtime stopped.", { runtimeSessionId: this.runtimeSessionId });
      return this.getState();
    } catch (error) {
      this.initializedAt = null;
      const failureInfo = this.serializeError(error);
      this.lastError = failureInfo;
      this.setSubsystemStatuses("error");
      this.transition("error");
      throw new CapCamError("RUNTIME_SHUTDOWN_FAILED", "Runtime shutdown could not release all resources.", {
        causeCode: failureInfo.code,
        reason: failureInfo.message,
      });
    }
  }

  private async failRuntime(error: unknown): Promise<void> {
    await this.serializeLifecycle(async () => {
      if (this.state === "stopped" || this.state === "error") return;
      if (this.state !== "stopping") this.transition("stopping");
      await this.waitForOperationsIdle();
      this.setSubsystemStatuses("stopping");
      try {
        await this.mediaRuntime.shutdown();
        this.initializedAt = null;
        this.setSubsystemStatuses("stopped");
      } catch (cleanupError) {
        this.lastError = this.serializeError(cleanupError);
        this.setSubsystemStatuses("error");
      }
      this.lastError ??= this.serializeError(error);
      this.transition("error");
    });
  }

  private authorizeSubsystemOperation(): CapCamError | null {
    if (this.state === "resetting") return new CapCamError("RUNTIME_RESETTING", "Runtime is resetting.");
    if (this.state === "stopped" || this.state === "stopping") return new CapCamError("RUNTIME_STOPPED", "Runtime is stopped.");
    if (this.state !== "ready" && this.state !== "active") {
      return new CapCamError("RUNTIME_NOT_READY", "Runtime is not ready for subsystem commands.", { state: this.state });
    }
    return null;
  }

  private syncActivityState(): void {
    if (this.state !== "ready" && this.state !== "active") return;
    const playbackState = this.mediaRuntime.playback.getState()?.state;
    const active = playbackState === "PLAYING" || this.mediaRuntime.streams.isRendererActive();
    if (active && this.state === "ready") this.transition("active");
    else if (!active && this.state === "active") this.transition("ready");
  }

  private transition(next: RuntimeState): void {
    const from = this.state;
    this.state = transitionRuntimeState(from, next);
    this.changedAt = this.now();
    logger.debug("Runtime lifecycle state changed.", { from, to: next, runtimeSessionId: this.runtimeSessionId });
    if (from !== next) this.publishState();
  }

  private publishState(): void {
    if (this.publishEvent === undefined) return;
    try {
      this.publishEvent(createEvent("runtime.lifecycleChanged", this.getState()));
    } catch (error) {
      logger.warn("Runtime lifecycle event could not be published.", {
        reason: error instanceof Error ? error.message : "Unknown event publication failure.",
      });
    }
  }

  private serializeError(error: unknown): SerializedRuntimeError {
    const failure = toCapCamError(error);
    const details: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(failure.metadata ?? {}).slice(0, 16)) {
      if (value === null || typeof value === "string" || typeof value === "boolean" ||
        (typeof value === "number" && Number.isFinite(value))) details[key] = value;
    }
    return {
      code: failure.code,
      message: failure.message.slice(0, 500),
      ...(Object.keys(details).length === 0 ? {} : { details }),
    };
  }

  private setSubsystemStatuses(status: RuntimeSubsystemState): void {
    this.subsystemStates = {
      mediaEngine: status,
      playbackEngine: status,
      canvasRenderer: status,
      streamManager: status,
    };
  }

  private waitForOperationsIdle(): Promise<void> {
    if (this.activeOperations === 0) return Promise.resolve();
    return new Promise((resolve) => this.operationsIdleWaiters.push(resolve));
  }

  private serializeLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.lifecycleQueue.then(operation, operation);
    this.lifecycleQueue = task.then(() => undefined, () => undefined);
    return task;
  }
}
