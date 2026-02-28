export type LogLevel = 'error' | 'info' | 'debug' | 'silent';

export class Logger {
  private readonly level: LogLevel;
  private readonly out: (message: string) => void;
  private readonly err: (message: string) => void;

  constructor(
    level: LogLevel,
    options: {
      out?: (message: string) => void;
      err?: (message: string) => void;
    } = {},
  ) {
    this.level = level;
    this.out = options.out ?? ((message: string): void => console.log(message));
    this.err = options.err ?? ((message: string): void => console.error(message));
  }

  static fromEnvironment(
    env: NodeJS.ProcessEnv = process.env,
    options: {
      out?: (message: string) => void;
      err?: (message: string) => void;
    } = {},
  ): Logger {
    return new Logger(Logger.normalizeLogLevel(env.RES_LOG_LEVEL), options);
  }

  static normalizeLogLevel(raw?: string): LogLevel {
    const value = raw?.trim().toLowerCase();
    if (value === 'error' || value === 'info' || value === 'debug' || value === 'silent') {
      return value;
    }
    return 'info';
  }

  debug(message: string): void {
    if (!this.shouldEmit('debug')) return;
    this.out(message);
  }

  info(message: string): void {
    if (!this.shouldEmit('info')) return;
    this.out(message);
  }

  error(message: string): void {
    if (!this.shouldEmit('error')) return;
    this.err(message);
  }

  private shouldEmit(eventLevel: Exclude<LogLevel, 'silent'>): boolean {
    if (this.level === 'silent') return false;
    if (this.level === 'debug') return true;
    if (this.level === 'info') return eventLevel === 'info' || eventLevel === 'error';
    return eventLevel === 'error';
  }
}