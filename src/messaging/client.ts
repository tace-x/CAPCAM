import { CapCamError } from "../shared/errors";
import { createCommand, type CommandArguments, type CommandResult, type CommandType } from "./commands";
import { isResponseData, isResponseEnvelope, type ResponseEnvelope } from "./protocol";

export interface MessageTransport {
  sendMessage(message: unknown): Promise<unknown>;
}

function createChromeTransport(): MessageTransport {
  return {
    async sendMessage(message) {
      if (typeof chrome === "undefined" || chrome.runtime?.sendMessage === undefined) {
        throw new CapCamError("CAPCAM_RUNTIME_ERROR", "CapCam extension messaging is unavailable in this context.");
      }
      return chrome.runtime.sendMessage(message);
    },
  };
}

function responseError(response: ResponseEnvelope): CapCamError {
  if (response.success || response.error === undefined) {
    return new CapCamError("CAPCAM_PROTOCOL_ERROR", "The extension returned an invalid error response.");
  }
  return new CapCamError(response.error.code, response.error.message, response.error.metadata);
}

export class MessagingClient {
  constructor(private readonly transport: MessageTransport = createChromeTransport()) {}

  async send<T extends CommandType>(type: T, ...args: CommandArguments<T>): Promise<CommandResult<T>> {
    const command = createCommand(type, ...args);
    let rawResponse: unknown;
    try {
      rawResponse = await this.transport.sendMessage(command);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Unknown message transport failure.";
      throw new CapCamError("CAPCAM_RUNTIME_ERROR", "Unable to reach the CapCam service worker.", { reason });
    }

    if (!isResponseEnvelope(rawResponse)) {
      throw new CapCamError("CAPCAM_PROTOCOL_ERROR", "The extension returned an invalid response envelope.");
    }
    if (rawResponse.requestId !== command.requestId) {
      throw new CapCamError("CAPCAM_PROTOCOL_ERROR", "The extension response did not match its request ID.");
    }
    if (!rawResponse.success) throw responseError(rawResponse);
    if (!isResponseData(type, rawResponse.data)) {
      throw new CapCamError("CAPCAM_PROTOCOL_ERROR", "The extension returned an invalid command response payload.", { type });
    }
    return rawResponse.data as CommandResult<T>;
  }
}

