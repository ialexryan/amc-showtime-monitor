import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import type { WorkerLeaseResult, WorkerState } from './database.js';
import {
  getErrorMessage,
  isAbortError,
  isRateLimitError,
  isTransientError,
} from './errors.js';
import type { TelegramCommandPollOptions } from './telegram.js';

export interface WorkerDatabase {
  acquireWorkerLease(
    workerId: string,
    now: Date,
    ttlMs: number
  ): WorkerLeaseResult;
  renewWorkerLease(
    workerId: string,
    now: Date,
    ttlMs: number,
    status?: string
  ): boolean;
  releaseWorkerLease(
    workerId: string,
    status: string,
    releasedAt: Date
  ): boolean;
  markWorkerPollStarted(workerId: string, startedAt: Date): boolean;
  markWorkerPollFinished(
    workerId: string,
    finishedAt: Date,
    pollStatus: string
  ): boolean;
  touchWorkerTelegramPoll(workerId: string, polledAt: Date): boolean;
  getWorkerState(): WorkerState | null;
  isClosed(): boolean;
}

export interface WorkerLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface WorkerMonitorRuntime {
  initialize(): Promise<void>;
  checkForNewShowtimes(signal?: AbortSignal): Promise<void>;
  processTelegramCommands(
    options?: TelegramCommandPollOptions & { throwOnError?: boolean }
  ): Promise<void>;
  flushLogs(): void;
  close(): void;
  getDatabase(): WorkerDatabase;
  getLogger(): WorkerLogger;
}

export interface WorkerClock {
  now(): Date;
  monotonicNow(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export interface MonitorWorkerOptions {
  pollIntervalMs?: number;
  amcCycleTimeoutMs?: number;
  healthcheckClient?: WorkerHealthcheckClient;
  healthchecksPingUrl?: string;
  telegramLongPollSeconds?: number;
  healthPort?: number;
  leaseTtlMs?: number;
  heartbeatIntervalMs?: number;
  standbyRetryMs?: number;
  shutdownGraceMs?: number;
  telegramFailureBackoffMs?: number;
  clock?: WorkerClock;
}

export interface WorkerHealthSnapshot {
  ok: boolean;
  ready: boolean;
  dbOpen: boolean;
  leaseHeld: boolean;
  mode: 'starting' | 'active' | 'standby' | 'stopping' | 'stopped';
  workerId: string;
  initialized: boolean;
  firstSuccessfulPoll: boolean;
  amcFresh: boolean;
  telegramFresh: boolean;
  lastPollStartedAt: string | null;
  lastPollFinishedAt: string | null;
  lastPollStatus: string | null;
  lastTelegramPollAt: string | null;
  workerState: WorkerState | null;
}

export interface WorkerHealthcheckClient {
  ping(url: string): Promise<void>;
}

const TRANSIENT_BACKOFF_STEPS_MS = [30_000, 60_000, 120_000, 240_000, 300_000];

const defaultHealthcheckClient: WorkerHealthcheckClient = {
  async ping(url: string): Promise<void> {
    const response = await fetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      throw new Error(`Healthchecks ping failed with HTTP ${response.status}`);
    }
  },
};

const defaultClock: WorkerClock = {
  now: () => new Date(),
  monotonicNow: () => performance.now(),
  sleep: async (ms: number, signal?: AbortSignal): Promise<void> => {
    await delay(ms, undefined, signal ? { signal } : undefined);
  },
};

export class MonitorWorker {
  private readonly workerId = randomUUID();
  private readonly database: WorkerDatabase;
  private readonly logger: WorkerLogger;
  private readonly clock: WorkerClock;
  private readonly pollIntervalMs: number;
  private readonly amcCycleTimeoutMs: number;
  private readonly healthcheckClient: WorkerHealthcheckClient;
  private readonly healthchecksPingUrl: string | undefined;
  private readonly telegramLongPollSeconds: number;
  private readonly healthPort: number | undefined;
  private readonly leaseTtlMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly standbyRetryMs: number;
  private readonly shutdownGraceMs: number;
  private readonly telegramFailureBackoffMs: number;
  private readonly shutdownController = new AbortController();

  private mode: WorkerHealthSnapshot['mode'] = 'starting';
  private initialized = false;
  private firstSuccessfulPoll = false;
  private leaseHeld = false;
  private lastPollStartedAt: Date | null = null;
  private lastPollFinishedAt: Date | null = null;
  private lastPollStatus: string | null = null;
  private lastTelegramPollAt: Date | null = null;
  private healthServer: Server | null = null;
  private sessionAbortController: AbortController | null = null;
  private isShuttingDown = false;
  private cleanupComplete = false;
  private signalHandlers = new Map<NodeJS.Signals, () => void>();

  constructor(
    private readonly monitor: WorkerMonitorRuntime,
    options: MonitorWorkerOptions = {}
  ) {
    this.database = monitor.getDatabase();
    this.logger = monitor.getLogger();
    this.clock = options.clock ?? defaultClock;
    this.pollIntervalMs = options.pollIntervalMs ?? 60_000;
    this.amcCycleTimeoutMs = options.amcCycleTimeoutMs ?? 45_000;
    this.healthcheckClient =
      options.healthcheckClient ?? defaultHealthcheckClient;
    this.healthchecksPingUrl = options.healthchecksPingUrl;
    this.telegramLongPollSeconds = options.telegramLongPollSeconds ?? 30;
    this.healthPort = options.healthPort;
    this.leaseTtlMs = options.leaseTtlMs ?? 45_000;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 15_000;
    this.standbyRetryMs = options.standbyRetryMs ?? 30_000;
    this.shutdownGraceMs = options.shutdownGraceMs ?? 20_000;
    this.telegramFailureBackoffMs = options.telegramFailureBackoffMs ?? 5_000;
  }

  async run(): Promise<void> {
    this.installSignalHandlers();
    await this.startHealthServer();
    this.info(`🚀 Starting long-running monitor worker (${this.workerId})`);

    try {
      while (!this.shutdownController.signal.aborted) {
        const acquired = this.database.acquireWorkerLease(
          this.workerId,
          this.clock.now(),
          this.leaseTtlMs
        );

        if (!acquired.acquired) {
          this.mode = 'standby';
          const ownerDescription = acquired.state?.workerId
            ? `${acquired.state.workerId} until ${acquired.state.leaseExpiresAt ?? 'unknown'}`
            : 'unknown owner';
          this.info(`⏳ Another worker holds the lease (${ownerDescription})`);
          await this.sleep(this.standbyRetryMs, this.shutdownController.signal);
          continue;
        }

        await this.runActiveSession();
      }
    } finally {
      await this.shutdown('stopped');
    }
  }

  getHealthSnapshot(): WorkerHealthSnapshot {
    const workerState = this.database.getWorkerState();
    const dbOpen = !this.database.isClosed();
    const amcFresh = this.isAmcLoopFresh();
    const telegramFresh = this.isTelegramLoopFresh();
    const ok = dbOpen && this.leaseHeld && amcFresh && telegramFresh;
    const ready =
      ok &&
      this.initialized &&
      this.firstSuccessfulPoll &&
      this.mode === 'active';

    return {
      ok,
      ready,
      dbOpen,
      leaseHeld: this.leaseHeld,
      mode: this.mode,
      workerId: this.workerId,
      initialized: this.initialized,
      firstSuccessfulPoll: this.firstSuccessfulPoll,
      amcFresh,
      telegramFresh,
      lastPollStartedAt: this.lastPollStartedAt?.toISOString() ?? null,
      lastPollFinishedAt: this.lastPollFinishedAt?.toISOString() ?? null,
      lastPollStatus: this.lastPollStatus,
      lastTelegramPollAt: this.lastTelegramPollAt?.toISOString() ?? null,
      workerState,
    };
  }

  stop(): void {
    if (this.shutdownController.signal.aborted) {
      return;
    }

    this.isShuttingDown = true;
    this.shutdownController.abort();
    this.sessionAbortController?.abort();
  }

  private async runActiveSession(): Promise<void> {
    this.leaseHeld = true;
    this.mode = 'active';
    this.sessionAbortController = new AbortController();

    let heartbeatPromise: Promise<void> | null = null;
    let amcPromise: Promise<void> | null = null;
    let telegramPromise: Promise<void> | null = null;

    try {
      heartbeatPromise = this.runHeartbeatLoop(
        this.sessionAbortController.signal
      );
      await this.ensureInitialized();
      amcPromise = this.runAmcLoop(this.sessionAbortController.signal);
      telegramPromise = this.runTelegramLoop(
        this.sessionAbortController.signal
      );

      await Promise.race([
        heartbeatPromise,
        Promise.all([amcPromise, telegramPromise]).then(() => undefined),
      ]);
    } catch (error) {
      if (!isAbortError(error)) {
        this.error(`❌ Worker session error: ${getErrorMessage(error)}`);
      }
    } finally {
      this.sessionAbortController.abort();
      await this.waitForSessionDrain(
        heartbeatPromise,
        amcPromise,
        telegramPromise
      );
      this.releaseLease(this.isShuttingDown ? 'stopping' : 'idle');
      this.sessionAbortController = null;
      if (!this.shutdownController.signal.aborted) {
        this.mode = 'standby';
      }
    }
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) {
      return;
    }

    await this.monitor.initialize();
    this.monitor.flushLogs();
    this.initialized = true;
  }

  private async runHeartbeatLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted && !this.shutdownController.signal.aborted) {
      await this.sleep(this.heartbeatIntervalMs, signal);
      if (signal.aborted || this.shutdownController.signal.aborted) {
        return;
      }

      const renewed = this.database.renewWorkerLease(
        this.workerId,
        this.clock.now(),
        this.leaseTtlMs,
        this.isShuttingDown ? 'stopping' : 'active'
      );

      if (!renewed) {
        throw new Error('Worker lease lost during heartbeat');
      }
    }
  }

  private async runAmcLoop(signal: AbortSignal): Promise<void> {
    let nextRunAt = this.clock.monotonicNow();
    let transientBackoffIndex = 0;

    while (!signal.aborted && !this.shutdownController.signal.aborted) {
      const waitMs = Math.max(0, nextRunAt - this.clock.monotonicNow());
      if (waitMs > 0) {
        await this.sleep(waitMs, signal);
      }

      if (signal.aborted || this.shutdownController.signal.aborted) {
        return;
      }

      const cycleStartedAt = this.clock.now();
      this.lastPollStartedAt = cycleStartedAt;
      this.lastPollStatus = 'running';
      this.database.markWorkerPollStarted(this.workerId, cycleStartedAt);

      let delayBeforeNextPollMs = 0;
      let shouldForceRestart = false;
      try {
        await this.runTimedAmcCheck(signal);
        this.firstSuccessfulPoll = true;
        this.lastPollStatus = 'ok';
        transientBackoffIndex = 0;
        await this.pingHealthchecks();
      } catch (error) {
        if (isRateLimitError(error)) {
          delayBeforeNextPollMs = 300_000;
          transientBackoffIndex = 0;
          this.lastPollStatus = 'rate-limited';
          this.warn('⚠️ AMC rate limit encountered; pausing polls for 300s');
        } else if (isTransientError(error)) {
          delayBeforeNextPollMs =
            TRANSIENT_BACKOFF_STEPS_MS[
              Math.min(
                transientBackoffIndex,
                TRANSIENT_BACKOFF_STEPS_MS.length - 1
              )
            ] ?? 300_000;
          transientBackoffIndex = Math.min(
            transientBackoffIndex + 1,
            TRANSIENT_BACKOFF_STEPS_MS.length - 1
          );
          this.lastPollStatus = 'transient-error';
          this.warn(
            `⚠️ AMC poll failed transiently; backing off for ${Math.round(delayBeforeNextPollMs / 1000)}s`
          );
        } else if (
          error instanceof Error &&
          error.message.startsWith('AMC poll cycle exceeded')
        ) {
          this.lastPollStatus = 'timed-out';
          this.error(`❌ AMC poll timed out: ${error.message}`);
          shouldForceRestart = true;
        } else {
          this.lastPollStatus = 'error';
          this.error(`❌ AMC poll failed: ${getErrorMessage(error)}`);
        }
      } finally {
        this.lastPollFinishedAt = this.clock.now();
        this.database.markWorkerPollFinished(
          this.workerId,
          this.lastPollFinishedAt,
          this.lastPollStatus ?? 'unknown'
        );
        this.monitor.flushLogs();
        if (shouldForceRestart) {
          await this.shutdown('stopping');
          process.exit(1);
        }
      }

      const scheduledNextRunAt = nextRunAt + this.pollIntervalMs;
      const monotonicNow = this.clock.monotonicNow();
      if (delayBeforeNextPollMs > 0) {
        nextRunAt = monotonicNow + delayBeforeNextPollMs;
        continue;
      }

      if (monotonicNow > scheduledNextRunAt) {
        this.warn(
          `⚠️ AMC poll cycle overran the ${Math.round(this.pollIntervalMs / 1000)}s interval; starting the next cycle immediately`
        );
        nextRunAt = monotonicNow;
      } else {
        nextRunAt = scheduledNextRunAt;
      }
    }
  }

  private async runTimedAmcCheck(signal: AbortSignal): Promise<void> {
    const requestAbortController = new AbortController();
    const timeoutAbortController = new AbortController();

    const forwardAbort = (): void => {
      requestAbortController.abort();
      timeoutAbortController.abort();
    };

    signal.addEventListener('abort', forwardAbort, { once: true });

    const timeoutPromise = this.clock
      .sleep(this.amcCycleTimeoutMs, timeoutAbortController.signal)
      .then(() => {
        requestAbortController.abort();
        throw new Error(
          `AMC poll cycle exceeded ${Math.round(this.amcCycleTimeoutMs / 1000)}s`
        );
      });

    try {
      await Promise.race([
        this.monitor.checkForNewShowtimes(requestAbortController.signal),
        timeoutPromise,
      ]);
    } finally {
      timeoutAbortController.abort();
      requestAbortController.abort();
      signal.removeEventListener('abort', forwardAbort);
    }
  }

  private async pingHealthchecks(): Promise<void> {
    if (!this.healthchecksPingUrl) {
      return;
    }

    try {
      await this.healthcheckClient.ping(this.healthchecksPingUrl);
    } catch (error) {
      this.warn(`⚠️ Healthchecks ping failed: ${getErrorMessage(error)}`);
    }
  }

  private async runTelegramLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted && !this.shutdownController.signal.aborted) {
      try {
        this.lastTelegramPollAt = this.clock.now();
        this.database.touchWorkerTelegramPoll(
          this.workerId,
          this.lastTelegramPollAt
        );
        await this.monitor.processTelegramCommands({
          timeoutSeconds: this.telegramLongPollSeconds,
          signal,
          throwOnError: true,
        });
        this.lastTelegramPollAt = this.clock.now();
        this.database.touchWorkerTelegramPoll(
          this.workerId,
          this.lastTelegramPollAt
        );
        this.monitor.flushLogs();
      } catch (error) {
        if (
          isAbortError(error) &&
          (signal.aborted || this.shutdownController.signal.aborted)
        ) {
          return;
        }

        this.error(`❌ Telegram polling failed: ${getErrorMessage(error)}`);
        await this.sleep(this.telegramFailureBackoffMs, signal);
      }
    }
  }

  private async waitForSessionDrain(
    heartbeatPromise: Promise<void> | null,
    amcPromise: Promise<void> | null,
    telegramPromise: Promise<void> | null
  ): Promise<void> {
    const activePromises = [
      heartbeatPromise,
      amcPromise,
      telegramPromise,
    ].filter((promise): promise is Promise<void> => promise !== null);

    if (activePromises.length === 0) {
      return;
    }

    try {
      await Promise.race([
        Promise.allSettled(activePromises),
        this.clock.sleep(this.shutdownGraceMs),
      ]);
    } catch (error) {
      if (!isAbortError(error)) {
        this.warn(`⚠️ Session drain warning: ${getErrorMessage(error)}`);
      }
    }
  }

  private releaseLease(status: string): void {
    if (!this.leaseHeld) {
      return;
    }

    this.database.releaseWorkerLease(this.workerId, status, this.clock.now());
    this.leaseHeld = false;
  }

  private isAmcLoopFresh(): boolean {
    if (!this.leaseHeld) {
      return false;
    }

    const freshnessAnchor = this.lastPollFinishedAt ?? this.lastPollStartedAt;
    if (!freshnessAnchor) {
      return false;
    }

    const freshnessWindowMs = Math.max(this.pollIntervalMs * 2, 120_000);
    return (
      this.clock.now().getTime() - freshnessAnchor.getTime() <=
      freshnessWindowMs
    );
  }

  private isTelegramLoopFresh(): boolean {
    if (!this.leaseHeld || !this.lastTelegramPollAt) {
      return false;
    }

    const freshnessWindowMs = Math.max(
      this.telegramLongPollSeconds * 2 * 1000,
      90_000
    );
    return (
      this.clock.now().getTime() - this.lastTelegramPollAt.getTime() <=
      freshnessWindowMs
    );
  }

  private async startHealthServer(): Promise<void> {
    if (this.healthPort === undefined) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      this.healthServer = createServer((request, response) => {
        const url = new URL(request.url || '/', 'http://127.0.0.1');
        const snapshot = this.getHealthSnapshot();

        if (url.pathname === '/healthz') {
          response.statusCode = snapshot.ok ? 200 : 503;
          response.setHeader('content-type', 'application/json');
          response.end(JSON.stringify(snapshot));
          return;
        }

        if (url.pathname === '/readyz') {
          response.statusCode = snapshot.ready ? 200 : 503;
          response.setHeader('content-type', 'application/json');
          response.end(JSON.stringify(snapshot));
          return;
        }

        response.statusCode = 404;
        response.end('Not found');
      });

      this.healthServer.once('error', reject);
      this.healthServer.listen(this.healthPort, '0.0.0.0', () => {
        this.info(`🌐 Health server listening on port ${this.healthPort}`);
        resolve();
      });
    });
  }

  private async stopHealthServer(): Promise<void> {
    if (!this.healthServer) {
      return;
    }

    const server = this.healthServer;
    this.healthServer = null;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  private installSignalHandlers(): void {
    const register = (signal: NodeJS.Signals): void => {
      const handler = (): void => {
        this.info(`🛑 Received ${signal}; shutting down worker`);
        this.stop();
      };
      process.on(signal, handler);
      this.signalHandlers.set(signal, handler);
    };

    register('SIGINT');
    register('SIGTERM');
  }

  private removeSignalHandlers(): void {
    for (const [signal, handler] of this.signalHandlers.entries()) {
      process.off(signal, handler);
    }
    this.signalHandlers.clear();
  }

  private async shutdown(status: 'stopping' | 'stopped'): Promise<void> {
    if (this.cleanupComplete) {
      return;
    }

    this.cleanupComplete = true;
    this.mode = status;
    this.sessionAbortController?.abort();
    this.releaseLease(status);
    await this.stopHealthServer().catch((error: unknown) => {
      this.warn(
        `⚠️ Failed to stop health server cleanly: ${getErrorMessage(error)}`
      );
    });
    this.monitor.flushLogs();
    this.monitor.close();
    this.removeSignalHandlers();
    this.mode = 'stopped';
  }

  private async sleep(ms: number, signal?: AbortSignal): Promise<void> {
    try {
      await this.clock.sleep(ms, signal);
    } catch (error) {
      if (isAbortError(error)) {
        return;
      }
      throw error;
    }
  }

  private info(message: string): void {
    this.logger.info(message);
    this.monitor.flushLogs();
  }

  private warn(message: string): void {
    this.logger.warn(message);
    this.monitor.flushLogs();
  }

  private error(message: string): void {
    this.logger.error(message);
    this.monitor.flushLogs();
  }
}
