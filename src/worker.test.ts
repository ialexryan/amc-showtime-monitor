import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ShowtimeDatabase } from './database.js';
import type {
  WorkerHealthcheckClient,
  WorkerLogger,
  WorkerMonitorRuntime,
} from './worker.js';
import { MonitorWorker } from './worker.js';

class FakeClock {
  private wallTimeMs = Date.parse('2026-03-08T00:00:00.000Z');
  private monotonicMs = 0;
  private timers: Array<{
    wakeAt: number;
    resolve: () => void;
    reject: (error: unknown) => void;
    signal: AbortSignal | undefined;
    onAbort: (() => void) | undefined;
  }> = [];

  now(): Date {
    return new Date(this.wallTimeMs);
  }

  monotonicNow(): number {
    return this.monotonicMs;
  }

  async sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }

    await new Promise<void>((resolve, reject) => {
      const timer = {
        wakeAt: this.monotonicMs + ms,
        resolve: () => {
          if (timer.signal && timer.onAbort) {
            timer.signal.removeEventListener('abort', timer.onAbort);
          }
          resolve();
        },
        reject: (error: unknown) => {
          if (timer.signal && timer.onAbort) {
            timer.signal.removeEventListener('abort', timer.onAbort);
          }
          reject(error);
        },
        signal,
        onAbort: undefined as (() => void) | undefined,
      };

      if (signal) {
        timer.onAbort = () => {
          this.timers = this.timers.filter((candidate) => candidate !== timer);
          timer.reject(new DOMException('Aborted', 'AbortError'));
        };
        signal.addEventListener('abort', timer.onAbort, { once: true });
      }

      this.timers.push(timer);
      this.timers.sort((left, right) => left.wakeAt - right.wakeAt);
    });
  }

  async advance(ms: number): Promise<void> {
    this.wallTimeMs += ms;
    this.monotonicMs += ms;
    await this.flushDueTimers();
  }

  async settle(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
    await this.flushDueTimers();
    await Promise.resolve();
  }

  private async flushDueTimers(): Promise<void> {
    let progressed = true;
    while (progressed) {
      progressed = false;
      const dueTimers = this.timers.filter(
        (timer) => timer.wakeAt <= this.monotonicMs
      );
      if (dueTimers.length === 0) {
        continue;
      }

      this.timers = this.timers.filter(
        (timer) => timer.wakeAt > this.monotonicMs
      );
      for (const timer of dueTimers) {
        timer.resolve();
      }
      progressed = true;
      await Promise.resolve();
      await Promise.resolve();
    }
  }
}

class FakeLogger implements WorkerLogger {
  readonly entries: Array<{
    level: 'info' | 'warn' | 'error';
    message: string;
  }> = [];

  info(message: string): void {
    this.entries.push({ level: 'info', message });
  }

  warn(message: string): void {
    this.entries.push({ level: 'warn', message });
  }

  error(message: string): void {
    this.entries.push({ level: 'error', message });
  }
}

class FakeHealthcheckClient implements WorkerHealthcheckClient {
  readonly pingedUrls: string[] = [];

  async ping(url: string): Promise<void> {
    this.pingedUrls.push(url);
  }
}

class FakeMonitor implements WorkerMonitorRuntime {
  readonly logger = new FakeLogger();
  readonly database: ShowtimeDatabase;
  readonly telegramOptions: Array<{
    timeoutSeconds?: number;
    throwOnError?: boolean;
  }> = [];
  readonly startupNotificationWorkerIds: string[] = [];

  initializeCalls = 0;
  checkCalls = 0;
  telegramCalls = 0;
  flushCalls = 0;
  closed = false;
  concurrentChecks = 0;
  maxConcurrentChecks = 0;

  constructor(
    private readonly clock: FakeClock,
    private readonly checkPlans: Array<{
      delayMs?: number;
      error?: unknown;
    }> = [],
    private readonly telegramPlans: Array<{
      delayMs?: number;
      error?: unknown;
    }> = [],
    dbPath: string = ':memory:'
  ) {
    this.database = new ShowtimeDatabase(dbPath);
  }

  async initialize(): Promise<void> {
    this.initializeCalls += 1;
  }

  async checkForNewShowtimes(signal?: AbortSignal): Promise<void> {
    this.checkCalls += 1;
    this.concurrentChecks += 1;
    this.maxConcurrentChecks = Math.max(
      this.maxConcurrentChecks,
      this.concurrentChecks
    );

    const plan = this.checkPlans.shift() ?? {};
    try {
      if (plan.delayMs) {
        await this.clock.sleep(plan.delayMs, signal);
      }

      if (plan.error) {
        throw plan.error;
      }
    } finally {
      this.concurrentChecks -= 1;
    }
  }

  async sendStartupNotification(workerId: string): Promise<void> {
    this.startupNotificationWorkerIds.push(workerId);
  }

  async processTelegramCommands(
    options: {
      timeoutSeconds?: number;
      signal?: AbortSignal;
      throwOnError?: boolean;
    } = {}
  ): Promise<void> {
    this.telegramCalls += 1;
    this.telegramOptions.push({
      ...(options.timeoutSeconds !== undefined
        ? { timeoutSeconds: options.timeoutSeconds }
        : {}),
      ...(options.throwOnError !== undefined
        ? { throwOnError: options.throwOnError }
        : {}),
    });

    const plan = this.telegramPlans.shift() ?? {};
    const delayMs = plan.delayMs ?? (options.timeoutSeconds ?? 0) * 1000;
    if (delayMs > 0) {
      await this.clock.sleep(delayMs, options.signal);
    }

    if (plan.error) {
      throw plan.error;
    }
  }

  flushLogs(): void {
    this.flushCalls += 1;
  }

  close(): void {
    this.closed = true;
    this.database.close();
  }

  getDatabase(): ShowtimeDatabase {
    return this.database;
  }

  getLogger(): FakeLogger {
    return this.logger;
  }
}

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) {
      continue;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

function createTempDatabasePath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'amc-showtime-monitor-'));
  tempDirs.push(dir);
  return join(dir, 'worker.db');
}

async function getUnusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to allocate a TCP port for testing');
  }

  const { port } = address;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });

  return port;
}

describe('MonitorWorker', () => {
  test('does not overlap AMC cycles and reruns immediately after an overrun', async () => {
    const clock = new FakeClock();
    const monitor = new FakeMonitor(clock, [
      { delayMs: 70_000 },
      { delayMs: 0 },
    ]);
    const worker = new MonitorWorker(monitor, {
      clock,
      pollIntervalMs: 60_000,
      amcCycleTimeoutMs: 120_000,
      telegramLongPollSeconds: 1,
      heartbeatIntervalMs: 15_000,
      leaseTtlMs: 45_000,
    });

    const runPromise = worker.run();
    await clock.settle();

    expect(monitor.initializeCalls).toBe(1);
    expect(monitor.checkCalls).toBe(1);
    expect(monitor.maxConcurrentChecks).toBe(1);

    await clock.advance(60_000);
    await clock.settle();
    expect(monitor.checkCalls).toBe(1);
    expect(monitor.maxConcurrentChecks).toBe(1);

    await clock.advance(10_000);
    await clock.settle();
    expect(monitor.checkCalls).toBe(2);
    expect(monitor.maxConcurrentChecks).toBe(1);

    worker.stop();
    await clock.advance(20_000);
    await runPromise;
    expect(monitor.closed).toBe(true);
  });

  test('applies transient and rate-limit backoff delays', async () => {
    const clock = new FakeClock();
    const monitor = new FakeMonitor(clock, [
      { error: new Error('network timeout') },
      {
        error: new Error(
          'Rate limited by AMC API. Please reduce polling frequency.'
        ),
      },
      { delayMs: 0 },
    ]);
    const worker = new MonitorWorker(monitor, {
      clock,
      pollIntervalMs: 60_000,
      amcCycleTimeoutMs: 120_000,
      telegramLongPollSeconds: 1,
      heartbeatIntervalMs: 15_000,
      leaseTtlMs: 45_000,
    });

    const runPromise = worker.run();
    await clock.settle();
    expect(monitor.checkCalls).toBe(1);

    await clock.advance(29_999);
    await clock.settle();
    expect(monitor.checkCalls).toBe(1);

    await clock.advance(60_000);
    await clock.settle();
    expect(monitor.checkCalls).toBe(2);

    await clock.advance(299_999);
    await clock.settle();
    expect(monitor.checkCalls).toBe(2);

    await clock.advance(60_000);
    await clock.settle();
    expect(monitor.checkCalls).toBe(3);

    worker.stop();
    await clock.advance(20_000);
    await runPromise;
  });

  test('pings Healthchecks after a successful showtime check', async () => {
    const clock = new FakeClock();
    const monitor = new FakeMonitor(clock, [{ delayMs: 0 }]);
    const healthcheckClient = new FakeHealthcheckClient();
    const worker = new MonitorWorker(monitor, {
      clock,
      pollIntervalMs: 60_000,
      amcCycleTimeoutMs: 120_000,
      healthchecksPingUrl:
        'https://hc-ping.com/935dd026-f916-4030-8fb1-8b89b6a9fc5e',
      healthcheckClient,
      telegramLongPollSeconds: 1,
      heartbeatIntervalMs: 15_000,
      leaseTtlMs: 45_000,
    });

    const runPromise = worker.run();
    await clock.settle();
    await clock.advance(1);
    await clock.settle();

    expect(monitor.startupNotificationWorkerIds).toHaveLength(1);
    expect(healthcheckClient.pingedUrls).toEqual([
      'https://hc-ping.com/935dd026-f916-4030-8fb1-8b89b6a9fc5e',
    ]);

    worker.stop();
    await clock.advance(20_000);
    await runPromise;
  });

  test('sends a startup notification once per worker process', async () => {
    const clock = new FakeClock();
    const monitor = new FakeMonitor(clock, [{ delayMs: 0 }, { delayMs: 0 }]);
    const worker = new MonitorWorker(monitor, {
      clock,
      pollIntervalMs: 60_000,
      amcCycleTimeoutMs: 120_000,
      telegramLongPollSeconds: 1,
      heartbeatIntervalMs: 15_000,
      leaseTtlMs: 45_000,
    });

    const runPromise = worker.run();
    await clock.settle();

    expect(monitor.startupNotificationWorkerIds).toHaveLength(1);
    expect(monitor.startupNotificationWorkerIds[0]?.length).toBeGreaterThan(0);

    await clock.advance(61_000);
    await clock.settle();
    expect(monitor.startupNotificationWorkerIds).toHaveLength(1);

    worker.stop();
    await clock.advance(20_000);
    await runPromise;
  });

  test('serves health and readiness endpoints after initialization and the first successful poll', async () => {
    const clock = new FakeClock();
    const monitor = new FakeMonitor(
      clock,
      [{ delayMs: 0 }],
      [{ delayMs: 1_000 }]
    );
    const healthPort = await getUnusedPort();
    const worker = new MonitorWorker(monitor, {
      clock,
      pollIntervalMs: 60_000,
      telegramLongPollSeconds: 1,
      healthPort,
      heartbeatIntervalMs: 15_000,
      leaseTtlMs: 45_000,
    });

    const runPromise = worker.run();
    await clock.settle();

    await clock.advance(31_000);
    await clock.settle();

    const healthResponse = await fetch(
      `http://127.0.0.1:${healthPort}/healthz`
    );
    const readinessResponse = await fetch(
      `http://127.0.0.1:${healthPort}/readyz`
    );
    const healthPayload = (await healthResponse.json()) as {
      dbOpen: boolean;
      initialized: boolean;
      leaseHeld: boolean;
      workerId: string;
    };
    const readinessPayload = (await readinessResponse.json()) as {
      initialized: boolean;
      workerId: string;
    };

    expect([200, 503]).toContain(healthResponse.status);
    expect([200, 503]).toContain(readinessResponse.status);
    expect(typeof healthPayload.dbOpen).toBe('boolean');
    expect(typeof healthPayload.initialized).toBe('boolean');
    expect(typeof healthPayload.leaseHeld).toBe('boolean');
    expect(healthPayload.workerId.length).toBeGreaterThan(0);
    expect(typeof readinessPayload.initialized).toBe('boolean');
    expect(readinessPayload.workerId.length).toBeGreaterThan(0);

    worker.stop();
    await clock.advance(20_000);
    await runPromise;
  });

  test('worker leases fail over after the existing lease expires', () => {
    const dbPath = createTempDatabasePath();
    const firstDatabase = new ShowtimeDatabase(dbPath);
    const secondDatabase = new ShowtimeDatabase(dbPath);
    const startedAt = new Date('2026-03-08T00:00:00.000Z');

    const firstAcquire = firstDatabase.acquireWorkerLease(
      'worker-1',
      startedAt,
      45_000
    );
    expect(firstAcquire.acquired).toBe(true);

    const secondAcquire = secondDatabase.acquireWorkerLease(
      'worker-2',
      new Date(startedAt.getTime() + 1_000),
      45_000
    );
    expect(secondAcquire.acquired).toBe(false);
    expect(secondAcquire.state?.workerId).toBe('worker-1');

    const failoverAcquire = secondDatabase.acquireWorkerLease(
      'worker-2',
      new Date(startedAt.getTime() + 46_000),
      45_000
    );
    expect(failoverAcquire.acquired).toBe(true);
    expect(failoverAcquire.state?.workerId).toBe('worker-2');

    firstDatabase.close();
    secondDatabase.close();
  });
});
