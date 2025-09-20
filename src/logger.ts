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
  debug(message: string, movie?: string, theatre?: string, data?: any): void {
    console.log(message);
    this.logBuffer.push({ level: 'DEBUG', message, movie, theatre, data });
  }

  info(message: string, movie?: string, theatre?: string, data?: any): void {
    console.log(message);
    this.logBuffer.push({ level: 'INFO', message, movie, theatre, data });
  }

  warn(message: string, movie?: string, theatre?: string, data?: any): void {
    console.log(message);
    this.logBuffer.push({ level: 'WARN', message, movie, theatre, data });
  }

  error(message: string, movie?: string, theatre?: string, data?: any): void {
    console.error(message);
    this.logBuffer.push({ level: 'ERROR', message, movie, theatre, data });
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
