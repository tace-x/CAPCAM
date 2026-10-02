import { CapCamError, toCapCamError } from "../shared/errors";
import { OFFSCREEN_DOCUMENT_PATH } from "../shared/constants";
import { createLogger } from "../shared/logger";
import type { OffscreenRuntimeInfo, OffscreenStatus } from "../shared/types";
import { createCommand, type CommandArguments, type CommandResult, type CommandType } from "../messaging/commands";
import { isResponseData, isResponseEnvelope } from "../messaging/protocol";

export type MediaCommandType = Extract<CommandType, `media.${string}`>;

export interface OffscreenService {
  initialize(): Promise<OffscreenRuntimeInfo>;
  getStatus(): Promise<OffscreenRuntimeInfo>;
  shutdown(): Promise<OffscreenRuntimeInfo>;
  execute<T extends MediaCommandType>(type: T, ...args: CommandArguments<T>): Promise<CommandResult<T>>;
}

export interface OffscreenPlatform {
  hasDocument(): Promise<boolean>;
  createDocument(): Promise<void>;
  closeDocument(): Promise<void>;
  sendMessage(message: unknown): Promise<unknown>;
}

const logger = createLogger("Offscreen");

export function createChromeOffscreenPlatform(): OffscreenPlatform {
  return {
    hasDocument: () => chrome.offscreen.hasDocument(),
    createDocument: async () => {
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_DOCUMENT_PATH,
        reasons: [chrome.offscreen.Reason.BLOBS],
        justification: "Loads local user-selected Blob files by object URL in the isolated extension media runtime.",
      });
    },
    closeDocument: () => chrome.offscreen.closeDocument(),
    sendMessage: (message) => chrome.runtime.sendMessage(message),
  };
}

function offscreenInfo(status: OffscreenStatus): OffscreenRuntimeInfo {
  return { status, initializedAt: null };
}

export class OffscreenManager implements OffscreenService {
  private info: OffscreenRuntimeInfo = offscreenInfo("STOPPED");
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly platform: OffscreenPlatform) {}

  initialize(): Promise<OffscreenRuntimeInfo> {
    return this.serialize(() => this.initializeUnlocked());
  }

  getStatus(): Promise<OffscreenRuntimeInfo> {
    return this.serialize(async () => {
      if (!(await this.platform.hasDocument())) {
        this.info = offscreenInfo("STOPPED");
        return { ...this.info };
      }
      try {
        this.info = await this.exchange("offscreen.getStatus");
        return { ...this.info };
      } catch (error) {
        this.info = offscreenInfo("ERROR");
        throw toCapCamError(error);
      }
    });
  }

  shutdown(): Promise<OffscreenRuntimeInfo> {
    return this.serialize(async () => {
      if (!(await this.platform.hasDocument())) {
        this.info = offscreenInfo("STOPPED");
        return { ...this.info };
      }

      try {
        await this.exchange("offscreen.shutdown");
      } catch (error) {
        const failure = toCapCamError(error);
        logger.warn("Offscreen shutdown command failed; closing the document anyway.", { code: failure.code });
      }

      try {
        await this.platform.closeDocument();
        this.info = offscreenInfo("STOPPED");
        return { ...this.info };
      } catch (error) {
        this.info = offscreenInfo("ERROR");
        throw new CapCamError("CAPCAM_RUNTIME_ERROR", "Unable to close the offscreen document.", {
          reason: error instanceof Error ? error.message : "Unknown close failure.",
        });
      }
    });
  }

  async execute<T extends MediaCommandType>(type: T, ...args: CommandArguments<T>): Promise<CommandResult<T>> {
    const status = await this.initialize();
    if (status.status !== "READY") {
      throw new CapCamError("CAPCAM_RUNTIME_ERROR", "Offscreen media runtime is not ready.");
    }
    return this.exchange(type, ...args);
  }

  private async initializeUnlocked(): Promise<OffscreenRuntimeInfo> {
    this.info = offscreenInfo("STARTING");
    let lastError: unknown;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await this.ensureDocument();
        this.info = await this.exchange("offscreen.initialize");
        return { ...this.info };
      } catch (error) {
        lastError = error;
        const failure = toCapCamError(error);
        logger.warn("Offscreen initialization attempt failed.", { attempt: attempt + 1, code: failure.code });
        if (attempt === 0) await this.closeBestEffort();
      }
    }

    this.info = offscreenInfo("ERROR");
    const failure = toCapCamError(lastError);
    throw new CapCamError("CAPCAM_RUNTIME_ERROR", "Unable to initialize the offscreen runtime.", {
      causeCode: failure.code,
      reason: failure.message,
    });
  }

  private async ensureDocument(): Promise<void> {
    if (await this.platform.hasDocument()) return;
    try {
      await this.platform.createDocument();
    } catch (error) {
      // Another lifecycle event may have created it between hasDocument() and createDocument().
      if (await this.platform.hasDocument()) return;
      throw error;
    }
  }

  private async exchange<T extends CommandType>(type: T, ...args: CommandArguments<T>): Promise<CommandResult<T>> {
    const command = createCommand(type, ...args);
    const response = await this.platform.sendMessage(command);
    if (!isResponseEnvelope(response)) {
      throw new CapCamError("CAPCAM_PROTOCOL_ERROR", "Offscreen runtime returned an invalid response envelope.");
    }
    if (response.requestId !== command.requestId) {
      throw new CapCamError("CAPCAM_PROTOCOL_ERROR", "Offscreen response did not match the request ID.");
    }
    if (!response.success) {
      const error = response.error;
      throw new CapCamError(
        error?.code ?? "CAPCAM_RUNTIME_ERROR",
        error?.message ?? "Offscreen runtime command failed.",
        error?.metadata,
      );
    }
    if (!isResponseData(type, response.data)) {
      throw new CapCamError("CAPCAM_PROTOCOL_ERROR", "Offscreen runtime returned an invalid command payload.", { type });
    }
    return response.data as CommandResult<T>;
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
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
