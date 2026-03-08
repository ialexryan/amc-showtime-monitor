import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ShowtimeDatabase } from './database.js';

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
  const dir = mkdtempSync(join(tmpdir(), 'amc-showtime-monitor-db-'));
  tempDirs.push(dir);
  return join(dir, 'monitor.db');
}

function seedShowtime(db: ShowtimeDatabase): number {
  db.upsertTheatre({
    id: 2325,
    name: 'AMC Metreon 16',
    slug: 'amc-metreon-16',
    location: 'San Francisco, CA',
  });

  const movieId = db.upsertMovie({
    name: 'Tron: Ares',
    slug: 'tron-ares',
  });

  const result = db.upsertShowtime({
    movieId,
    theatreId: 2325,
    showDateTime: '2026-10-09T02:00:00Z',
    showDateTimeLocal: '2026-10-08T19:00:00',
    utcOffset: '-07:00',
    auditorium: 1,
    isSoldOut: false,
    isAlmostSoldOut: false,
    attributes: '[]',
    ticketUrl: 'https://www.amctheatres.com/showtimes/123/seats',
  });

  return result.id;
}

describe('ShowtimeDatabase notification delivery', () => {
  test('keeps showtimes pending until delivery is acknowledged', () => {
    const db = new ShowtimeDatabase(createTempDatabasePath());
    const showtimeId = seedShowtime(db);

    const firstFetch = db.getPendingNotifications();
    expect(firstFetch).toHaveLength(1);
    expect(firstFetch[0]?.showtimeId).toBe(showtimeId);

    const retryFetch = db.getPendingNotifications();
    expect(retryFetch).toHaveLength(1);
    expect(retryFetch[0]?.showtimeId).toBe(showtimeId);

    db.markNotificationsDelivered([showtimeId]);

    expect(db.getPendingNotifications()).toHaveLength(0);
    expect(db.getUnnotifiedShowtimes()).toHaveLength(0);

    db.close();
  });

  test('watchlist entries enforce unique resolved movie ids', () => {
    const db = new ShowtimeDatabase(createTempDatabasePath());
    const firstEntry = db.createOrGetWatchlistEntry('Tron 3', 'tron 3').entry;
    const secondEntry = db.createOrGetWatchlistEntry(
      'Tron: Ares',
      'tron ares'
    ).entry;

    expect(firstEntry?.id).toBeDefined();
    expect(secondEntry?.id).toBeDefined();

    const resolvedAt = new Date().toISOString();
    const firstResolved = db.saveWatchlistEntryResolved(
      firstEntry?.id ?? -1,
      {
        id: 123,
        slug: 'tron-ares',
        name: 'Tron: Ares',
      },
      resolvedAt
    );
    const originalConsoleError = console.error;
    console.error = () => undefined;
    const secondResolved = db.saveWatchlistEntryResolved(
      secondEntry?.id ?? -1,
      {
        id: 123,
        slug: 'tron-ares',
        name: 'Tron: Ares',
      },
      resolvedAt
    );
    console.error = originalConsoleError;

    expect(firstResolved?.resolvedMovieId).toBe(123);
    expect(secondResolved).toBeNull();

    db.close();
  });
});
