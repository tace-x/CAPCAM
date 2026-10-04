import { CapCamError, toCapCamError } from "../shared/errors";
import { OFFSCREEN_DOCUMENT_PATH } from "../shared/constants";
import { createLogger } from "../shared/logger";
import type { OffscreenRuntimeInfo } from "../shared/types";
import { attachRuntimeSessionId, createCommand, type CommandArguments, type CommandResult, type CommandType } from "../messaging/commands";
import { isResponseData, isResponseEnvelope } from "../messaging/protocol";
import type { RuntimeDiagnostics, RuntimePingResponse, RuntimeStateSnapshot } from "../shared/runtime-types";

export type MediaCommandType = Extract<CommandType, `media.${string}` | `stream.${string}` | `playback.${string}` | `runtime.${string}`>;
export type OffscreenCommandType = MediaCommandType;

export interface OffscreenService {
  initialize(): Promise<OffscreenRuntimeInfo>;
  getStatus(): Promise<OffscreenRuntimeInfo>;
  shutdown(): Promise<OffscreenRuntimeInfo>;
  getKnownRuntimeSessionId?(): string | null;
  observeRuntimeLifecycle?(snapshot: RuntimeStateSnapshot): void;
  execute<T extends OffscreenCommandType>(type: T, ...args: CommandArguments<T>): Promise<CommandResult<T>>;
}

export interface OffscreenPlatform {
  hasDocument(): Promise<boolean>;
  createDocument(): Promise<void>;
  closeDocument(): Promise<void>;
  sendMessage(message: unknown): Promise<unknown>;
}

export interface OffscreenManagerOptions {
  requestTimeoutMs?: number;
  setTimeout?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimeout?: (handle: ReturnType<typeof setTimeout>) => void;
}

interface ExchangeOptions {
  runtimeSessionId?: string;
  allowSessionRotation?: boolean;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 35_000;
const MAX_REQUEST_TIMEOUT_MS = 60_000;
// @types/chrome@0.0.287 predates OFFSCREEN_DOCUMENT in ContextType; Chrome has exposed it since 116.
const OFFSCREEN_CONTEXT_TYPE = "OFFSCREEN_DOCUMENT" as unknown as chrome.runtime.ContextType;
const logger = createLogger("Offscreen");

export function createChromeOffscreenPlatform(): OffscreenPlatform {
  return {
    hasDocument: async () => {
      // runtime.getContexts() is available from Chrome 116 (our manifest minimum).
      // chrome.offscreen.hasDocument() is newer and would break older supported builds.
      const contexts = await chrome.runtime.getContexts({
        contextTypes: [OFFSCREEN_CONTEXT_TYPE],
        documentUrls: [chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH)],
      });
      return contexts.length > 0;
    },
    createDocument: async () => {
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_DOCUMENT_PATH,
        reasons: [chrome.offscreen.Reason.BLOBS],
        justification: "Loads user-selected local Blob media and owns its canvas-based rendering and capture stream in the isolated extension runtime.",
      });
    },
    closeDocument: () => chrome.offscreen.closeDocument(),
    sendMessage: (message) => chrome.runtime.sendMessage(message),
  };
}

function offscreenInfo(snapshot: RuntimeStateSnapshot): OffscreenRuntimeInfo {
  const status: OffscreenRuntimeInfo["status"] =
    snapshot.state === "created" || snapshot.state === "stopped" ? "STOPPED"
      : snapshot.state === "initializing" || snapshot.state === "stopping" || snapshot.state === "resetting" ? "STARTING"
      : snapshot.state === "error" ? "ERROR"
      : "READY";
  return { status, initializedAt: snapshot.initializedAt };
}

function stoppedInfo(): OffscreenRuntimeInfo {
  return { status: "STOPPED", initializedAt: null };
}

function runtimeSessionIdFrom(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const sessionId = (value as Record<string, unknown>).runtimeSessionId;
  return typeof sessionId === "string" ? sessionId : undefined;
}

function isRuntimeInitializationError(error: unknown): boolean {
  const failure = toCapCamError(error);
  return failure.code === "RUNTIME_INITIALIZATION_FAILED" || failure.code === "RUNTIME_SHUTDOWN_FAILED";
}

function isTransportFailure(error: unknown): boolean {
  const failure = toCapCamError(error);
  return failure.code === "CAPCAM_RUNTIME_ERROR" && failure.metadata?.offscreenTransportFailure === true;
}

function isStaleRuntimeResponse(error: unknown): boolean {
  return toCapCamError(error).code === "RUNTIME_SESSION_MISMATCH";
}

export class OffscreenManager implements OffscreenService {
  private info: OffscreenRuntimeInfo = stoppedInfo();
  private runtimeState: RuntimeStateSnapshot | null = null;
  private runtimeSessionId: string | null = null;
  private queue: Promise<void> = Promise.resolve();
  private recovery: Promise<RuntimeStateSnapshot> | null = null;
  private readonly requestTimeoutMs: number;
  private readonly setTimer: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (handle: ReturnType<typeof setTimeout>) => void;

  constructor(private readonly platform: OffscreenPlatform, options: OffscreenManagerOptions = {}) {
    const requestedTimeout = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.requestTimeoutMs = Number.isFinite(requestedTimeout)
      ? Math.min(MAX_REQUEST_TIMEOUT_MS, Math.max(1, Math.floor(requestedTimeout)))
      : DEFAULT_REQUEST_TIMEOUT_MS;
    this.setTimer = options.setTimeout ?? ((callback, delayMs) => globalThis.setTimeout(callback, delayMs));
    this.clearTimer = options.clearTimeout ?? ((handle) => globalThis.clearTimeout(handle));
  }

  initialize(): Promise<OffscreenRuntimeInfo> {
    return this.serialize(async () => {
      if (await this.platform.hasDocument() && (this.runtimeState?.state === "ready" || this.runtimeState?.state === "active")) {
        this.info = offscreenInfo(this.runtimeState);
        return { ...this.info };
      }
      const snapshot = await this.initializeUnlocked();
      return offscreenInfo(snapshot);
    });
  }

  getStatus(): Promise<OffscreenRuntimeInfo> {
    return this.serialize(async () => {
      if (!(await this.platform.hasDocument())) {
        this.info = stoppedInfo();
        this.runtimeState = null;
        this.runtimeSessionId = null;
        return { ...this.info };
      }
      const snapshot = await this.exchange("runtime.getState", [], { allowSessionRotation: true });
      this.rememberState(snapshot);
      return { ...this.info };
    });
  }

  shutdown(): Promise<OffscreenRuntimeInfo> {
    return this.serialize(async () => {
      if (!(await this.platform.hasDocument())) {
        this.info = stoppedInfo();
        this.runtimeState = null;
        this.runtimeSessionId = null;
        return { ...this.info };
      }
      await this.ensureSessionKnown();
      const snapshot = await this.exchangeWithSessionRefresh("runtime.shutdown", [], false);
      this.rememberState(snapshot);
      try {
        await this.platform.closeDocument();
      } catch (error) {
        this.info = { status: "ERROR", initializedAt: null };
        throw new CapCamError("CAPCAM_RUNTIME_ERROR", "Unable to close the offscreen document after runtime shutdown.", {
          reason: error instanceof Error ? error.message : "Unknown close failure.",
        });
      }
      this.info = stoppedInfo();
      this.runtimeState = null;
      this.runtimeSessionId = null;
      return { ...this.info };
    });
  }

  async execute<T extends OffscreenCommandType>(type: T, ...args: CommandArguments<T>): Promise<CommandResult<T>> {
    if (type === "runtime.initialize") {
      return await this.initializeRuntimeState() as CommandResult<T>;
    }
    if (type === "runtime.getState" || type === "runtime.getDiagnostics" || type === "runtime.ping") {
      return await this.serialize(async () => {
        await this.ensureOffscreenDocument();
        return this.exchange(type, args as CommandArguments<T>, { allowSessionRotation: true });
      }) as CommandResult<T>;
    }
    if (type === "runtime.shutdown") {
      return await this.shutdownRuntimeCommand() as CommandResult<T>;
    }
    if (type === "runtime.reset") {
      return await this.serialize(async () => {
        await this.ensureOffscreenDocument();
        await this.ensureSessionKnown();
        return this.exchangeWithSessionRefresh(type, args as CommandArguments<T>, true);
      }) as CommandResult<T>;
    }

    return this.executeSubsystemCommand(type, args as CommandArguments<T>);
  }

  async ensureOffscreenDocument(): Promise<void> {
    if (await this.platform.hasDocument()) return;
    try {
      await this.platform.createDocument();
    } catch (error) {
      // Another lifecycle event may have created the singleton document between check and create.
      if (await this.platform.hasDocument()) return;
      throw error;
    }
  }

  getKnownRuntimeSessionId(): string | null {
    return this.runtimeSessionId;
  }

  observeRuntimeLifecycle(snapshot: RuntimeStateSnapshot): void {
    this.rememberState(snapshot);
  }

  private async shutdownRuntimeCommand(): Promise<RuntimeStateSnapshot> {
    return this.serialize(async () => {
      if (!(await this.platform.hasDocument()) && this.runtimeState?.state === "stopped") return this.runtimeState;
      await this.ensureOffscreenDocument();
      await this.ensureSessionKnown();
      const snapshot = await this.exchangeWithSessionRefresh("runtime.shutdown", [], false);
      this.rememberState(snapshot);
      try {
        await this.platform.closeDocument();
      } catch (error) {
        throw new CapCamError("CAPCAM_RUNTIME_ERROR", "Runtime resources were released, but the offscreen document could not be closed.", {
          reason: error instanceof Error ? error.message : "Unknown close failure.",
        });
      }
      this.info = stoppedInfo();
      this.runtimeSessionId = null;
      return snapshot;
    });
  }

  private async initializeRuntimeState(): Promise<RuntimeStateSnapshot> {
    return this.serialize(() => this.initializeUnlocked());
  }

  private async initializeUnlocked(): Promise<RuntimeStateSnapshot> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await this.ensureOffscreenDocument();
      try {
        const current = await this.exchange("runtime.getState", [], { allowSessionRotation: true });
        this.rememberState(current);
        if (current.state === "ready" || current.state === "active") return current;
        if (current.state === "error") {
          const recovered = await this.exchange("runtime.reset", [], {
            runtimeSessionId: current.runtimeSessionId,
            allowSessionRotation: true,
          });
          this.rememberState(recovered);
          return recovered;
        }
        const ready = await this.exchange("runtime.initialize", [], { allowSessionRotation: true });
        this.rememberState(ready);
        return ready;
      } catch (error) {
        lastError = error;
        const failure = toCapCamError(error);
        logger.warn("Offscreen initialization attempt failed.", { attempt: attempt + 1, code: failure.code });
        // A timeout is inconclusive: the command may still be running. Keep the document and retry/query later.
        if (failure.code === "RUNTIME_REQUEST_TIMEOUT" || isRuntimeInitializationError(error) || attempt === 1) {
          this.info = failure.code === "RUNTIME_REQUEST_TIMEOUT" ? this.info : { status: "ERROR", initializedAt: null };
          throw error;
        }
        await this.closeBestEffort();
        this.runtimeSessionId = null;
        this.runtimeState = null;
      }
    }
    throw toCapCamError(lastError);
  }

  private async ensureSessionKnown(): Promise<void> {
    if (this.runtimeSessionId !== null) return;
    await this.refreshRuntimeStateUnlocked();
  }

  private async refreshRuntimeStateUnlocked(): Promise<RuntimeStateSnapshot> {
    const snapshot = await this.exchange("runtime.getState", [], { allowSessionRotation: true });
    this.rememberState(snapshot);
    return snapshot;
  }

  private async exchangeWithSessionRefresh<T extends CommandType>(
    type: T,
    args: CommandArguments<T>,
    allowSessionRotation: boolean,
  ): Promise<CommandResult<T>> {
    try {
      return await this.exchange(type, args, this.sessionOptions(allowSessionRotation));
    } catch (error) {
      if (!isStaleRuntimeResponse(error)) throw error;
      await this.refreshRuntimeStateUnlocked();
      return this.exchange(type, args, this.sessionOptions(allowSessionRotation));
    }
  }

  private executeSubsystemCommand<T extends OffscreenCommandType>(
    type: T,
    args: CommandArguments<T>,
  ): Promise<CommandResult<T>> {
    return this.runSubsystemCommand(type, args);
  }

  private async runSubsystemCommand<T extends OffscreenCommandType>(
    type: T,
    args: CommandArguments<T>,
  ): Promise<CommandResult<T>> {
    await this.initialize();
    if (this.runtimeSessionId === null) throw new CapCamError("RUNTIME_NOT_READY", "Offscreen runtime session is unavailable.");
    try {
      return await this.exchange(type, args, { runtimeSessionId: this.runtimeSessionId });
    } catch (error) {
      const code = toCapCamError(error).code;
      let recreateDocument = false;
      if (isStaleRuntimeResponse(error) || code === "RUNTIME_NOT_READY" || code === "RUNTIME_STOPPED") {
        recreateDocument = false;
      } else if (isTransportFailure(error)) {
        recreateDocument = true;
      } else {
        throw error;
      }
      await this.recoverRuntime(recreateDocument);
      if (this.runtimeSessionId === null) throw new CapCamError("RUNTIME_NOT_READY", "Offscreen runtime session is unavailable after recovery.");
      return this.exchange(type, args, { runtimeSessionId: this.runtimeSessionId });
    }
  }

  private recoverRuntime(recreateDocument: boolean): Promise<RuntimeStateSnapshot> {
    if (this.recovery !== null) return this.recovery;
    const pending = this.serialize(async () => {
      if (recreateDocument) {
        await this.closeBestEffort();
        this.info = stoppedInfo();
        this.runtimeState = null;
        this.runtimeSessionId = null;
      }
      return this.initializeUnlocked();
    }).finally(() => {
      if (this.recovery === pending) this.recovery = null;
    });
    this.recovery = pending;
    return pending;
  }

  private sessionOptions(allowSessionRotation = false): ExchangeOptions {
    return {
      ...(this.runtimeSessionId === null ? {} : { runtimeSessionId: this.runtimeSessionId }),
      ...(allowSessionRotation ? { allowSessionRotation: true } : {}),
    };
  }

  private async exchange<T extends CommandType>(
    type: T,
    args: CommandArguments<T> = [] as unknown as CommandArguments<T>,
    options: ExchangeOptions = {},
  ): Promise<CommandResult<T>> {
    const baseCommand = createCommand(type, ...args);
    const command = options.runtimeSessionId === undefined
      ? baseCommand
      : attachRuntimeSessionId(baseCommand, options.runtimeSessionId);
    const response = await this.sendWithTimeout(command, type);
    if (!isResponseEnvelope(response)) {
      throw new CapCamError("CAPCAM_PROTOCOL_ERROR", "Offscreen runtime returned an invalid response envelope.");
    }
    if (response.requestId !== command.requestId) {
      throw new CapCamError("CAPCAM_PROTOCOL_ERROR", "Offscreen response did not match the request ID.");
    }

    const dataSessionId = response.success ? runtimeSessionIdFrom(response.data) : undefined;
    const responseSessionId = response.runtimeSessionId ?? dataSessionId;
    if (!response.success) {
      if (responseSessionId !== undefined) this.runtimeSessionId = responseSessionId;
      const error = response.error;
      throw new CapCamError(
        error?.code ?? "CAPCAM_RUNTIME_ERROR",
        error?.message ?? "Offscreen runtime command failed.",
        error?.metadata,
      );
    }

    if (responseSessionId !== undefined) {
      const expectedSessionId = options.runtimeSessionId;
      if (!options.allowSessionRotation && expectedSessionId !== undefined && responseSessionId !== expectedSessionId) {
        this.runtimeSessionId = responseSessionId;
        throw new CapCamError("CAPCAM_PROTOCOL_ERROR", "Offscreen response belongs to a different runtime session.", {
          command: type,
          expectedRuntimeSessionId: expectedSessionId,
          receivedRuntimeSessionId: responseSessionId,
        });
      }
      this.runtimeSessionId = responseSessionId;
    }

    if (!isResponseData(type, response.data)) {
      throw new CapCamError("CAPCAM_PROTOCOL_ERROR", "Offscreen runtime returned an invalid command payload.", { type });
    }
    if (type === "runtime.initialize" || type === "runtime.reset" || type === "runtime.getState" || type === "runtime.shutdown") {
      this.rememberState(response.data as RuntimeStateSnapshot);
    } else if (type === "runtime.getDiagnostics") {
      const diagnostics = response.data as RuntimeDiagnostics;
      this.rememberState(diagnostics);
    } else if (type === "runtime.ping") {
      const ping = response.data as RuntimePingResponse;
      if (responseSessionId === undefined) this.runtimeSessionId = ping.runtimeSessionId;
    }
    return response.data as CommandResult<T>;
  }

  private async sendWithTimeout(message: unknown, commandType: string): Promise<unknown> {
    const pending = Promise.resolve().then(() => this.platform.sendMessage(message));
    return new Promise<unknown>((resolve, reject) => {
      let settled = false;
      const timer = this.setTimer(() => {
        if (settled) return;
        settled = true;
        reject(new CapCamError("RUNTIME_REQUEST_TIMEOUT", "Offscreen runtime request timed out.", {
          command: commandType,
          timeoutMs: this.requestTimeoutMs,
        }));
      }, this.requestTimeoutMs);
      pending.then((value) => {
        if (settled) return;
        settled = true;
        this.clearTimer(timer);
        resolve(value);
      }).catch((error: unknown) => {
        if (settled) return;
        settled = true;
        this.clearTimer(timer);
        reject(new CapCamError("CAPCAM_RUNTIME_ERROR", "Offscreen runtime message delivery failed.", {
          offscreenTransportFailure: true,
          reason: error instanceof Error ? error.message.slice(0, 300) : "Unknown message delivery failure.",
        }));
      });
    });
  }

  private rememberState(snapshot: RuntimeStateSnapshot): void {
    this.runtimeState = { ...snapshot, lastError: snapshot.lastError === null ? null : { ...snapshot.lastError } };
    this.runtimeSessionId = snapshot.runtimeSessionId;
    this.info = offscreenInfo(snapshot);
  }

  private async closeBestEffort(): Promise<void> {
    try {
      if (await this.platform.hasDocument()) await this.platform.closeDocument();
    } catch (error) {
      logger.warn("Could not close an unresponsive offscreen document.", {
        code: toCapCamError(error).code,
      });
    }
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
}
