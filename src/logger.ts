import { randomUUID } from 'node:crypto';
import type { ShowtimeDatabase } from './database.js';

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

export class Logger {
  private database: ShowtimeDatabase;
  private runId: string;
  private logBuffer: Array<{
    level: LogLevel;
    message: string;
    movie?: string;
    theatre?: string;
    data?: unknown;
  }> = [];

  constructor(database: ShowtimeDatabase) {
    this.database = database;
    this.runId = randomUUID();
  }

  private pushLog(
    level: LogLevel,
    message: string,
    options?: { movie?: string; theatre?: string; data?: unknown }
  ): void {
    const entry: {
      level: LogLevel;
      message: string;
      movie?: string;
      theatre?: string;
      data?: unknown;
    } = { level, message };

    if (options?.movie !== undefined) {
      entry.movie = options.movie;
    }
    if (options?.theatre !== undefined) {
      entry.theatre = options.theatre;
    }
    if (options?.data !== undefined) {
      entry.data = options.data;
    }

    this.logBuffer.push(entry);
  }

  // Log methods that capture to buffer and also output to console
  debug(
    message: string,
    options?: { movie?: string; theatre?: string; data?: unknown }
  ): void {
    console.log(message);
    this.pushLog('DEBUG', message, options);
  }

  info(
    message: string,
    options?: { movie?: string; theatre?: string; data?: unknown }
  ): void {
    console.log(message);
    this.pushLog('INFO', message, options);
  }

  warn(
    message: string,
    options?: { movie?: string; theatre?: string; data?: unknown }
  ): void {
    console.warn(message);
    this.pushLog('WARN', message, options);
  }

  error(
    message: string,
    options?: { movie?: string; theatre?: string; data?: unknown }
  ): void {
    console.error(message);
    this.pushLog('ERROR', message, options);
  }

  // Save all buffered logs to database
  flush(): void {
    for (const log of this.logBuffer) {
      this.database.addLog(
        this.runId,
        log.level,
        log.message,
        log.movie,
        log.theatre,
        log.data
      );
    }
    this.logBuffer = [];
  }

  // Get the current run ID
  getRunId(): string {
    return this.runId;
  }
}
