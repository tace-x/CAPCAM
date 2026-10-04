import { CapCamError, toCapCamError } from "../shared/errors";
import { createLogger } from "../shared/logger";
import { generateRequestId, type CommandArguments, type CommandEnvelope, type CommandMap, type CommandPayload, type CommandResult, type CommandType } from "./commands";
import { createErrorResponse, createSuccessResponse, extractRequestId, isResponseData, validateCommand, type ResponseEnvelope } from "./protocol";

export type CommandHandler<T extends CommandType> = (
  payload: CommandPayload<T>,
) => CommandResult<T> | Promise<CommandResult<T>>;

type UntypedCommandHandler = (payload: unknown) => unknown | Promise<unknown>;
type CommandAuthorizer = (command: CommandEnvelope) => CapCamError | null | undefined;
const logger = createLogger("Protocol");

export interface CommandRouterOptions {
  authorize?: CommandAuthorizer;
  getRuntimeSessionId?: () => string | undefined;
}

export class CommandRouter {
  private readonly handlers = new Map<CommandType, UntypedCommandHandler>();

  constructor(private readonly options: CommandRouterOptions = {}) {}

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
      return createErrorResponse(requestId, validation.error, this.readSessionId());
    }

    const { command } = validation;
    try {
      const authorizationError = this.options.authorize?.(command);
      if (authorizationError !== null && authorizationError !== undefined) throw authorizationError;
      const handler = this.handlers.get(command.type);
      if (handler === undefined) {
        throw new CapCamError("UNKNOWN_COMMAND", "Command is not available in this runtime context.", { type: command.type });
      }
      const payload = "payload" in command ? command.payload : undefined;
      const data = await handler(payload);
      if (!isResponseData(command.type, data)) {
        throw new CapCamError("INVALID_PAYLOAD", "Command handler returned an invalid response payload.", { type: command.type });
      }
      return createSuccessResponse(command.requestId, data, this.readSessionId(data));
    } catch (error) {
      const capcamError = toCapCamError(error);
      logger.warn("Command handler returned a structured error.", { type: command.type, code: capcamError.code });
      return createErrorResponse(command.requestId, capcamError, this.readSessionId());
    }
  }

  private readSessionId(value?: unknown): string | undefined {
    try {
      const current = this.options.getRuntimeSessionId?.();
      if (current !== undefined) return current;
    } catch {
      // A response can still carry the session identifier captured in its serializable data.
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const sessionId = (value as Record<string, unknown>).runtimeSessionId;
    return typeof sessionId === "string" ? sessionId : undefined;
  }
}

export type { CommandArguments, CommandMap, CommandPayload, CommandResult, CommandType };
