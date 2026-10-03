export type LogScope = "Runtime" | "Offscreen" | "Protocol" | "Storage" | "Stream" | "Playback" | "Media" | "Site";
export type LogMethod = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(message: string, ...details: unknown[]): void;
  info(message: string, ...details: unknown[]): void;
  warn(message: string, ...details: unknown[]): void;
  error(message: string, ...details: unknown[]): void;
}

export function createLogger(scope: LogScope): Logger {
  const prefix = `[CapCam][${scope}]`;
  const write = (method: LogMethod, message: string, details: unknown[]): void => {
    console[method](prefix, message, ...details);
  };

  return {
    debug: (message, ...details) => write("debug", message, details),
    info: (message, ...details) => write("info", message, details),
    warn: (message, ...details) => write("warn", message, details),
    error: (message, ...details) => write("error", message, details),
  };
}
