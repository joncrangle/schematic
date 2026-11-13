export type LogLevel = "debug" | "info" | "warn" | "error" | "none";

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  none: 4,
};

class Logger {
  /**
   * Resolves the active level once per isolate at module init. Wrangler vars
   * are immutable per isolate, so "goes live" means live relative to the
   * deployed bundle, not re-read per call. Runtime LOG_LEVEL takes effect
   * under nodejs_compat; unrecognized values fall back to "info" rather
   * than silently suppressing every level.
   */
  private static resolveLogLevel(): LogLevel {
    const known = (value: unknown): LogLevel | undefined =>
      typeof value === "string" && value in LOG_LEVEL_PRIORITY ? (value as LogLevel) : undefined;

    const runtime = typeof process !== "undefined" ? process.env?.LOG_LEVEL : undefined;
    const buildTime =
      typeof import.meta !== "undefined"
        ? (import.meta as { env?: Record<string, unknown> }).env?.LOG_LEVEL
        : undefined;

    return known(runtime) ?? known(buildTime) ?? "info";
  }

  private currentLevel: LogLevel = Logger.resolveLogLevel();

  public setLevel(level: LogLevel): void {
    this.currentLevel = level;
  }

  public getLevel(): LogLevel {
    return this.currentLevel;
  }

  private shouldLog(level: LogLevel): boolean {
    if (this.currentLevel === "none") return false;
    return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[this.currentLevel];
  }

  public debug(message: string, ...data: unknown[]): void {
    if (this.shouldLog("debug")) {
      console.debug(`[Schematic Live:DEBUG] ${message}`, ...data);
    }
  }

  public info(message: string, ...data: unknown[]): void {
    if (this.shouldLog("info")) {
      console.info(`[Schematic Live:INFO] ${message}`, ...data);
    }
  }

  public warn(message: string, ...data: unknown[]): void {
    if (this.shouldLog("warn")) {
      console.warn(`[Schematic Live:WARN] ${message}`, ...data);
    }
  }

  public error(message: string, ...data: unknown[]): void {
    if (this.shouldLog("error")) {
      console.error(`[Schematic Live:ERROR] ${message}`, ...data);
    }
  }
}

export const logger = new Logger();
