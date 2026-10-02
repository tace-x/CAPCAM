import { CapCamError } from "../shared/errors";
import { createCommand, type CommandArguments, type CommandResult, type CommandType } from "./commands";
import { isEventEnvelope, isResponseData, isResponseEnvelope, type ResponseEnvelope } from "./protocol";
import type { EventEnvelope } from "./events";

export interface MessageTransport {
  sendMessage(message: unknown): Promise<unknown>;
}

export interface RuntimeEventSender {
  id?: string | undefined;
  url?: string | undefined;
}

export type RuntimeEventListener = (message: unknown, sender: RuntimeEventSender) => void;

export interface RuntimeEventSource {
  extensionId: string;
  backgroundUrl: string;
  addListener(listener: RuntimeEventListener): void;
  removeListener(listener: RuntimeEventListener): void;
}

function createChromeEventSource(): RuntimeEventSource | undefined {
  if (typeof chrome === "undefined" || chrome.runtime?.onMessage === undefined) return undefined;
  const registered = new Map<RuntimeEventListener, (message: unknown, sender: chrome.runtime.MessageSender) => void>();
  return {
    extensionId: chrome.runtime.id,
    backgroundUrl: chrome.runtime.getURL("background.js"),
    addListener(listener) {
      const wrapped = (message: unknown, sender: chrome.runtime.MessageSender): void => listener(message, sender);
      registered.set(listener, wrapped);
      chrome.runtime.onMessage.addListener(wrapped);
    },
    removeListener(listener) {
      const wrapped = registered.get(listener);
      if (wrapped === undefined) return;
      registered.delete(listener);
      chrome.runtime.onMessage.removeListener(wrapped);
    },
  };
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
  constructor(
    private readonly transport: MessageTransport = createChromeTransport(),
    private readonly eventSource: RuntimeEventSource | undefined = createChromeEventSource(),
  ) {}

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

  subscribeEvents(listener: (event: EventEnvelope) => void): () => void {
    const source = this.eventSource;
    if (source === undefined) return () => undefined;
    const onMessage: RuntimeEventListener = (message, sender) => {
      if (sender.id !== source.extensionId || sender.url !== source.backgroundUrl) return;
      if (isEventEnvelope(message)) listener(message);
    };
    source.addListener(onMessage);
    return () => source.removeListener(onMessage);
  }
}

