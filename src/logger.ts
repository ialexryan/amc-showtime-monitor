import { randomUUID } from 'crypto';
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
    data?: any;
  }> = [];

  constructor(database: ShowtimeDatabase) {
    this.database = database;
    this.runId = randomUUID();
  }

  // Log methods that capture to buffer and also output to console
  debug(
    message: string,
    options?: { movie?: string; theatre?: string; data?: any }
  ): void {
    console.log(message);
    this.logBuffer.push({
      level: 'DEBUG',
      message,
      movie: options?.movie,
      theatre: options?.theatre,
      data: options?.data,
    });
  }

  info(
    message: string,
    options?: { movie?: string; theatre?: string; data?: any }
  ): void {
    console.log(message);
    this.logBuffer.push({
      level: 'INFO',
      message,
      movie: options?.movie,
      theatre: options?.theatre,
      data: options?.data,
    });
  }

  warn(
    message: string,
    options?: { movie?: string; theatre?: string; data?: any }
  ): void {
    console.warn(message);
    this.logBuffer.push({
      level: 'WARN',
      message,
      movie: options?.movie,
      theatre: options?.theatre,
      data: options?.data,
    });
  }

  error(
    message: string,
    options?: { movie?: string; theatre?: string; data?: any }
  ): void {
    console.error(message);
    this.logBuffer.push({
      level: 'ERROR',
      message,
      movie: options?.movie,
      theatre: options?.theatre,
      data: options?.data,
    });
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
