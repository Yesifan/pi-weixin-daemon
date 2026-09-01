import { pino, type Logger } from "pino";

export type { Logger } from "pino";

export interface LoggerOptions {
  level?: string;
  pretty?: boolean;
}

/** Create the daemon logger. Pretty mode is for interactive use; JSON mode for systemd/journald. */
export function createLogger(opts: LoggerOptions = {}): Logger {
  const level = opts.level ?? process.env.PI_WEIXIN_LOG_LEVEL ?? "info";
  if (opts.pretty) {
    return pino({
      level,
      transport: {
        target: "pino-pretty",
        options: { colorize: true, translateTime: "SYS:HH:MM:ss" },
      },
    });
  }
  return pino({ level });
}
