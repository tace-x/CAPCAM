import { CapCamError, toCapCamError } from "../shared/errors";
import { createLogger } from "../shared/logger";
import { generateRequestId, type CommandArguments, type CommandMap, type CommandPayload, type CommandResult, type CommandType } from "./commands";
import { createErrorResponse, createSuccessResponse, extractRequestId, isResponseData, validateCommand, type ResponseEnvelope } from "./protocol";

export type CommandHandler<T extends CommandType> = (
  payload: CommandPayload<T>,
) => CommandResult<T> | Promise<CommandResult<T>>;

type UntypedCommandHandler = (payload: unknown) => unknown | Promise<unknown>;
const logger = createLogger("Protocol");

export class CommandRouter {
  private readonly handlers = new Map<CommandType, UntypedCommandHandler>();

  register<T extends CommandType>(type: T, handler: CommandHandler<T>): void {
    if (this.handlers.has(type)) {
      throw new CapCamError("CAPCAM_PROTOCOL_ERROR", "A handler is already registered for this command.", { type });
    }
    this.handlers.set(type, (payload) => handler(payload as CommandPayload<T>));
  }

  async handle(message: unknown): Promise<ResponseEnvelope> {
    const validation = validateCommand(message);
    if (!validation.ok) {
      const requestId = validation.requestId ?? extractRequestId(message) ?? generateRequestId();
      logger.warn("Command validation failed.", { requestId, message: validation.error.message });
      return createErrorResponse(requestId, validation.error);
    }

    const { command } = validation;
    try {
      const handler = this.handlers.get(command.type);
      if (handler === undefined) {
        throw new CapCamError("CAPCAM_PROTOCOL_ERROR", "Command is not available in this runtime context.", { type: command.type });
      }
      const payload = "payload" in command ? command.payload : undefined;
      const data = await handler(payload);
      if (!isResponseData(command.type, data)) {
        throw new CapCamError("CAPCAM_PROTOCOL_ERROR", "Command handler returned an invalid response payload.", { type: command.type });
      }
      return createSuccessResponse(command.requestId, data);
    } catch (error) {
      const capcamError = toCapCamError(error);
      logger.warn("Command handler returned a structured error.", { type: command.type, code: capcamError.code });
      return createErrorResponse(command.requestId, capcamError);
    }
  }
}

export type { CommandArguments, CommandMap, CommandPayload, CommandResult, CommandType };
