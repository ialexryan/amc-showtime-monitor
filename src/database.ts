import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync } from 'node:fs';

export interface Theatre {
  id: number;
  name: string;
  slug: string;
  location: string;
}

export interface Movie {
  id: number;
  name: string;
  slug: string;
  releaseDate?: string;
  mpaaRating?: string;
  runTime?: number;
  genre?: string;
  lastChecked: string;
}

export interface Showtime {
  id: number;
  movieId: number;
  theatreId: number;
  showDateTime: string;
  showDateTimeLocal: string;
  auditorium: number;
  isSoldOut: boolean;
  isAlmostSoldOut: boolean;
  attributes: string; // JSON string of attributes
  ticketUrl?: string;
  firstSeen: string;
  notified: boolean;
}

export interface WorkerState {
  id: number;
  workerId: string | null;
  leaseExpiresAt: string | null;
  lastHeartbeatAt: string | null;
  status: string;
  lastPollStartedAt: string | null;
  lastPollFinishedAt: string | null;
  lastPollStatus: string | null;
  lastTelegramPollAt: string | null;
  updatedAt: string;
}

export interface WorkerLeaseResult {
  acquired: boolean;
  state: WorkerState | null;
}

export class ShowtimeDatabase {
  private db: Database;
  private closed = false;

  constructor(
    dbPath: string = process.env.DATABASE_PATH || './data/amc-monitor.db'
  ) {
    this.db = new Database(dbPath);

    // Enable WAL mode for better concurrent access handling
    this.db.exec('PRAGMA journal_mode = WAL');

    // Set busy timeout to 5 seconds to handle concurrent access
    this.db.exec('PRAGMA busy_timeout = 5000');

    // Enable foreign key constraints
    this.db.exec('PRAGMA foreign_keys = ON');

    // Run periodic checkpoints to prevent WAL file from growing too large
    this.db.exec('PRAGMA wal_autocheckpoint = 1000');

    // --- Additional Best Practices (Optimized for Safety) ---

    // Synchronous mode: EXTRA for maximum durability
    // EXTRA = safest possible (syncs after every transaction + extra syncs)
    // Since we don't care about speed, use maximum safety
    this.db.exec('PRAGMA synchronous = EXTRA');

    // Store temporary tables on disk for crash recovery
    // FILE = safer than MEMORY, survives crashes
    this.db.exec('PRAGMA temp_store = FILE');

    // Increase cache size to 10MB (helps with consistency)
    // Negative value = size in KB
    this.db.exec('PRAGMA cache_size = -10000');

    // Disable memory-mapped I/O for maximum safety
    // mmap can cause corruption if process crashes during write
    this.db.exec('PRAGMA mmap_size = 0');

    // Enable query optimizer statistics
    this.db.exec('PRAGMA automatic_index = ON');

    // Set reasonable page size (4096 is good default for most systems)
    // Note: Can only be set on new databases, ignored on existing ones
    this.db.exec('PRAGMA page_size = 4096');

    // Enable incremental vacuum for automatic space reclamation
    this.db.exec('PRAGMA auto_vacuum = INCREMENTAL');

    this.initTables();
  }

  private initTables() {
    // Create tables with proper indexes
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS theatres (
        id INTEGER PRIMARY KEY NOT NULL,
        name TEXT UNIQUE NOT NULL,
        slug TEXT UNIQUE NOT NULL,
        location TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS movies (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        slug TEXT UNIQUE NOT NULL,
        release_date TEXT,
        mpaa_rating TEXT,
        run_time INTEGER,
        genre TEXT,
        last_checked DATETIME DEFAULT CURRENT_TIMESTAMP,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS showtimes (
        id INTEGER PRIMARY KEY,
        movie_id INTEGER NOT NULL,
        theatre_id INTEGER NOT NULL,
        show_date_time TEXT NOT NULL,
        show_date_time_local TEXT NOT NULL,
        auditorium INTEGER,
        is_sold_out BOOLEAN DEFAULT FALSE,
        is_almost_sold_out BOOLEAN DEFAULT FALSE,
        attributes TEXT, -- JSON
        ticket_url TEXT,
        first_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
        notified BOOLEAN DEFAULT FALSE,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (movie_id) REFERENCES movies (id),
        FOREIGN KEY (theatre_id) REFERENCES theatres (id),
        UNIQUE(movie_id, theatre_id, show_date_time, auditorium)
      );

      CREATE TABLE IF NOT EXISTS watchlist (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        movie_name TEXT UNIQUE NOT NULL,
        added_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS bot_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        timestamp DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        level TEXT NOT NULL DEFAULT 'INFO',
        message TEXT NOT NULL,
        movie TEXT,
        theatre TEXT,
        data TEXT -- JSON for additional structured data
      );

      CREATE TABLE IF NOT EXISTS worker_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        worker_id TEXT,
        lease_expires_at DATETIME,
        last_heartbeat_at DATETIME,
        status TEXT NOT NULL DEFAULT 'idle',
        last_poll_started_at DATETIME,
        last_poll_finished_at DATETIME,
        last_poll_status TEXT,
        last_telegram_poll_at DATETIME,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      DROP INDEX IF EXISTS idx_worker_state_lease_expires_at;

      -- Indexes for performance
      CREATE INDEX IF NOT EXISTS idx_showtimes_movie_theatre ON showtimes (movie_id, theatre_id);
      CREATE INDEX IF NOT EXISTS idx_showtimes_notified ON showtimes (notified);
      CREATE INDEX IF NOT EXISTS idx_showtimes_first_seen ON showtimes (first_seen);
      CREATE INDEX IF NOT EXISTS idx_movies_last_checked ON movies (last_checked);
      CREATE INDEX IF NOT EXISTS idx_watchlist_movie_name ON watchlist (movie_name);
      CREATE INDEX IF NOT EXISTS idx_logs_run_id ON logs (run_id);
      CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON logs (timestamp);
    `);
  }

  private mapWorkerState(
    row:
      | {
          id: number;
          worker_id: string | null;
          lease_expires_at: string | null;
          last_heartbeat_at: string | null;
          status: string;
          last_poll_started_at: string | null;
          last_poll_finished_at: string | null;
          last_poll_status: string | null;
          last_telegram_poll_at: string | null;
          updated_at: string;
        }
      | null
      | undefined
  ): WorkerState | null {
    if (!row) {
      return null;
    }

    return {
      id: row.id,
      workerId: row.worker_id,
      leaseExpiresAt: row.lease_expires_at,
      lastHeartbeatAt: row.last_heartbeat_at,
      status: row.status,
      lastPollStartedAt: row.last_poll_started_at,
      lastPollFinishedAt: row.last_poll_finished_at,
      lastPollStatus: row.last_poll_status,
      lastTelegramPollAt: row.last_telegram_poll_at,
      updatedAt: row.updated_at,
    };
  }

  // Theatre operations
  upsertTheatre(theatre: Theatre): number {
    const stmt = this.db.prepare(`
      INSERT INTO theatres (id, name, slug, location) 
      VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        slug = excluded.slug,
        location = excluded.location
      RETURNING id
    `);
    const result = stmt.get(
      theatre.id,
      theatre.name,
      theatre.slug,
      theatre.location
    ) as {
      id: number;
    };
    return result.id;
  }

  getTheatreByName(name: string): Theatre | null {
    const stmt = this.db.prepare('SELECT * FROM theatres WHERE name LIKE ?');
    return stmt.get(`%${name}%`) as Theatre | null;
  }

  // Movie operations
  upsertMovie(movie: Omit<Movie, 'id' | 'lastChecked'>): number {
    const stmt = this.db.prepare(`
      INSERT INTO movies (name, slug, release_date, mpaa_rating, run_time, genre) 
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(slug) DO UPDATE SET
        name = excluded.name,
        release_date = excluded.release_date,
        mpaa_rating = excluded.mpaa_rating,
        run_time = excluded.run_time,
        genre = excluded.genre,
        last_checked = CURRENT_TIMESTAMP
      RETURNING id
    `);
    const result = stmt.get(
      movie.name,
      movie.slug,
      movie.releaseDate ?? null,
      movie.mpaaRating ?? null,
      movie.runTime ?? null,
      movie.genre ?? null
    ) as { id: number };
    return result.id;
  }

  updateMovieLastChecked(movieId: number) {
    const stmt = this.db.prepare(
      'UPDATE movies SET last_checked = CURRENT_TIMESTAMP WHERE id = ?'
    );
    stmt.run(movieId);
  }

  // Showtime operations
  upsertShowtime(showtime: Omit<Showtime, 'id' | 'firstSeen' | 'notified'>): {
    id: number;
    isNew: boolean;
  } {
    const existingStmt = this.db.prepare(`
      SELECT id, first_seen FROM showtimes 
      WHERE movie_id = ? AND theatre_id = ? AND show_date_time = ? AND auditorium = ?
    `);
    const existing = existingStmt.get(
      showtime.movieId,
      showtime.theatreId,
      showtime.showDateTime,
      showtime.auditorium
    ) as { id: number; first_seen: string } | null;

    if (existing) {
      // Update existing showtime
      const updateStmt = this.db.prepare(`
        UPDATE showtimes SET
          show_date_time_local = ?,
          is_sold_out = ?,
          is_almost_sold_out = ?,
          attributes = ?,
          ticket_url = ?
        WHERE id = ?
      `);
      updateStmt.run(
        showtime.showDateTimeLocal,
        showtime.isSoldOut,
        showtime.isAlmostSoldOut,
        showtime.attributes,
        showtime.ticketUrl ?? null,
        existing.id
      );
      return { id: existing.id, isNew: false };
    } else {
      // Insert new showtime
      const insertStmt = this.db.prepare(`
        INSERT INTO showtimes 
        (movie_id, theatre_id, show_date_time, show_date_time_local, auditorium, 
         is_sold_out, is_almost_sold_out, attributes, ticket_url) 
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const result = insertStmt.run(
        showtime.movieId,
        showtime.theatreId,
        showtime.showDateTime,
        showtime.showDateTimeLocal,
        showtime.auditorium,
        showtime.isSoldOut,
        showtime.isAlmostSoldOut,
        showtime.attributes,
        showtime.ticketUrl ?? null
      );
      return { id: Number(result.lastInsertRowid), isNew: true };
    }
  }

  getUnnotifiedShowtimes(): Array<
    Showtime & { movieName: string; theatreName: string }
  > {
    const stmt = this.db.prepare(`
      SELECT s.*, m.name as movieName, t.name as theatreName
      FROM showtimes s
      JOIN movies m ON s.movie_id = m.id
      JOIN theatres t ON s.theatre_id = t.id
      WHERE s.notified = FALSE
      ORDER BY s.first_seen ASC
    `);
    return stmt.all() as Array<
      Showtime & { movieName: string; theatreName: string }
    >;
  }

  markShowtimeNotified(showtimeId: number) {
    const stmt = this.db.prepare(
      'UPDATE showtimes SET notified = TRUE WHERE id = ?'
    );
    stmt.run(showtimeId);
  }

  // Watchlist operations
  addToWatchlist(movieName: string): boolean {
    try {
      const stmt = this.db.prepare(`
        INSERT OR IGNORE INTO watchlist (movie_name) VALUES (?)
      `);
      const result = stmt.run(movieName);
      return result.changes > 0;
    } catch (error) {
      console.error('Error adding to watchlist:', error);
      return false;
    }
  }

  removeFromWatchlist(movieName: string): boolean {
    try {
      const stmt = this.db.prepare(`
        DELETE FROM watchlist WHERE movie_name = ? COLLATE NOCASE
      `);
      const result = stmt.run(movieName);
      return result.changes > 0;
    } catch (error) {
      console.error('Error removing from watchlist:', error);
      return false;
    }
  }

  getWatchlist(): string[] {
    try {
      const stmt = this.db.prepare(`
        SELECT movie_name FROM watchlist ORDER BY added_at ASC
      `);
      const rows = stmt.all() as Array<{ movie_name: string }>;
      return rows.map((row) => row.movie_name);
    } catch (error) {
      console.error('Error getting watchlist:', error);
      return [];
    }
  }

  // Bot state operations
  setBotState(key: string, value: string): void {
    try {
      const stmt = this.db.prepare(`
        INSERT OR REPLACE INTO bot_state (key, value, updated_at) 
        VALUES (?, ?, CURRENT_TIMESTAMP)
      `);
      stmt.run(key, value);
    } catch (error) {
      console.error('Error setting bot state:', error);
    }
  }

  getBotState(key: string): string | null {
    try {
      const stmt = this.db.prepare(`
        SELECT value FROM bot_state WHERE key = ?
      `);
      const result = stmt.get(key) as { value: string } | undefined;
      return result?.value || null;
    } catch (error) {
      console.error('Error getting bot state:', error);
      return null;
    }
  }

  // Worker state operations
  getWorkerState(): WorkerState | null {
    try {
      const stmt = this.db.prepare(`
        SELECT * FROM worker_state WHERE id = 1
      `);
      return this.mapWorkerState(
        stmt.get() as
          | {
              id: number;
              worker_id: string | null;
              lease_expires_at: string | null;
              last_heartbeat_at: string | null;
              status: string;
              last_poll_started_at: string | null;
              last_poll_finished_at: string | null;
              last_poll_status: string | null;
              last_telegram_poll_at: string | null;
              updated_at: string;
            }
          | undefined
      );
    } catch (error) {
      console.error('Error getting worker state:', error);
      return null;
    }
  }

  acquireWorkerLease(
    workerId: string,
    now: Date,
    ttlMs: number
  ): WorkerLeaseResult {
    try {
      const nowIso = now.toISOString();
      const leaseExpiresAt = new Date(now.getTime() + ttlMs).toISOString();
      const acquireLease = this.db.transaction(
        (
          ownerId: string,
          currentTimeIso: string,
          leaseExpiresAtIso: string
        ): WorkerLeaseResult => {
          const selectStmt = this.db.prepare(`
            SELECT * FROM worker_state WHERE id = 1
          `);

          const currentState = this.mapWorkerState(
            selectStmt.get() as
              | {
                  id: number;
                  worker_id: string | null;
                  lease_expires_at: string | null;
                  last_heartbeat_at: string | null;
                  status: string;
                  last_poll_started_at: string | null;
                  last_poll_finished_at: string | null;
                  last_poll_status: string | null;
                  last_telegram_poll_at: string | null;
                  updated_at: string;
                }
              | undefined
          );

          const activeOwnerExists =
            currentState?.workerId !== null &&
            currentState?.workerId !== undefined &&
            currentState.workerId !== ownerId &&
            currentState.leaseExpiresAt !== null &&
            currentState.leaseExpiresAt !== undefined &&
            new Date(currentState.leaseExpiresAt).getTime() > now.getTime();

          if (activeOwnerExists) {
            return { acquired: false, state: currentState };
          }

          if (currentState) {
            const updateStmt = this.db.prepare(`
              UPDATE worker_state
              SET worker_id = ?,
                  lease_expires_at = ?,
                  last_heartbeat_at = ?,
                  status = 'active',
                  updated_at = CURRENT_TIMESTAMP
              WHERE id = 1
            `);
            updateStmt.run(ownerId, leaseExpiresAtIso, currentTimeIso);
          } else {
            const insertStmt = this.db.prepare(`
              INSERT INTO worker_state (
                id,
                worker_id,
                lease_expires_at,
                last_heartbeat_at,
                status
              ) VALUES (1, ?, ?, ?, 'active')
            `);
            insertStmt.run(ownerId, leaseExpiresAtIso, currentTimeIso);
          }

          return {
            acquired: true,
            state: this.mapWorkerState(
              selectStmt.get() as
                | {
                    id: number;
                    worker_id: string | null;
                    lease_expires_at: string | null;
                    last_heartbeat_at: string | null;
                    status: string;
                    last_poll_started_at: string | null;
                    last_poll_finished_at: string | null;
                    last_poll_status: string | null;
                    last_telegram_poll_at: string | null;
                    updated_at: string;
                  }
                | undefined
            ),
          };
        }
      );

      return acquireLease(workerId, nowIso, leaseExpiresAt);
    } catch (error) {
      console.error('Error acquiring worker lease:', error);
      return { acquired: false, state: this.getWorkerState() };
    }
  }

  renewWorkerLease(
    workerId: string,
    now: Date,
    ttlMs: number,
    status: string = 'active'
  ): boolean {
    try {
      const stmt = this.db.prepare(`
        UPDATE worker_state
        SET lease_expires_at = ?,
            last_heartbeat_at = ?,
            status = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = 1 AND worker_id = ?
      `);
      const leaseExpiresAt = new Date(now.getTime() + ttlMs).toISOString();
      const result = stmt.run(
        leaseExpiresAt,
        now.toISOString(),
        status,
        workerId
      );
      return result.changes > 0;
    } catch (error) {
      console.error('Error renewing worker lease:', error);
      return false;
    }
  }

  releaseWorkerLease(
    workerId: string,
    status: string,
    releasedAt: Date
  ): boolean {
    try {
      const stmt = this.db.prepare(`
        UPDATE worker_state
        SET worker_id = NULL,
            lease_expires_at = NULL,
            last_heartbeat_at = ?,
            status = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = 1 AND worker_id = ?
      `);
      const result = stmt.run(releasedAt.toISOString(), status, workerId);
      return result.changes > 0;
    } catch (error) {
      console.error('Error releasing worker lease:', error);
      return false;
    }
  }

  markWorkerPollStarted(workerId: string, startedAt: Date): boolean {
    try {
      const stmt = this.db.prepare(`
        UPDATE worker_state
        SET last_poll_started_at = ?,
            last_poll_status = 'running',
            status = 'active',
            updated_at = CURRENT_TIMESTAMP
        WHERE id = 1 AND worker_id = ?
      `);
      const result = stmt.run(startedAt.toISOString(), workerId);
      return result.changes > 0;
    } catch (error) {
      console.error('Error marking worker poll start:', error);
      return false;
    }
  }

  markWorkerPollFinished(
    workerId: string,
    finishedAt: Date,
    pollStatus: string
  ): boolean {
    try {
      const stmt = this.db.prepare(`
        UPDATE worker_state
        SET last_poll_finished_at = ?,
            last_poll_status = ?,
            status = 'active',
            updated_at = CURRENT_TIMESTAMP
        WHERE id = 1 AND worker_id = ?
      `);
      const result = stmt.run(finishedAt.toISOString(), pollStatus, workerId);
      return result.changes > 0;
    } catch (error) {
      console.error('Error marking worker poll finish:', error);
      return false;
    }
  }

  touchWorkerTelegramPoll(workerId: string, polledAt: Date): boolean {
    try {
      const stmt = this.db.prepare(`
        UPDATE worker_state
        SET last_telegram_poll_at = ?,
            status = 'active',
            updated_at = CURRENT_TIMESTAMP
        WHERE id = 1 AND worker_id = ?
      `);
      const result = stmt.run(polledAt.toISOString(), workerId);
      return result.changes > 0;
    } catch (error) {
      console.error('Error updating Telegram poll timestamp:', error);
      return false;
    }
  }

  // Log operations
  addLog(
    runId: string,
    level: string,
    message: string,
    movie?: string,
    theatre?: string,
    data?: unknown
  ): void {
    try {
      const stmt = this.db.prepare(`
        INSERT INTO logs (run_id, level, message, movie, theatre, data)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      stmt.run(
        runId,
        level,
        message,
        movie || null,
        theatre || null,
        data ? JSON.stringify(data) : null
      );
    } catch (error) {
      console.error('Error adding log:', error);
    }
  }

  getLogsByRunId(runId: string): Array<{
    id: number;
    run_id: string;
    timestamp: string;
    level: string;
    message: string;
    movie?: string;
    theatre?: string;
    data?: string;
  }> {
    try {
      const stmt = this.db.prepare(`
        SELECT * FROM logs 
        WHERE run_id = ? 
        ORDER BY timestamp ASC
      `);
      return stmt.all(runId) as Array<{
        id: number;
        run_id: string;
        timestamp: string;
        level: string;
        message: string;
        movie?: string;
        theatre?: string;
        data?: string;
      }>;
    } catch (error) {
      console.error('Error getting logs by run ID:', error);
      return [];
    }
  }

  getRecentRunIds(limit: number = 5): string[] {
    try {
      const stmt = this.db.prepare(`
        SELECT run_id FROM logs 
        GROUP BY run_id 
        ORDER BY MAX(timestamp) DESC 
        LIMIT ?
      `);
      const results = stmt.all(limit) as Array<{ run_id: string }>;
      return results.map((r) => r.run_id);
    } catch (error) {
      console.error('Error getting recent run IDs:', error);
      return [];
    }
  }

  getRunCountSince(hours: number): number {
    try {
      const stmt = this.db.prepare(`
        SELECT COUNT(DISTINCT run_id) as count FROM logs
        WHERE datetime(timestamp) >= datetime('now', '-${hours} hours')
      `);
      const result = stmt.get() as { count: number };
      return result.count;
    } catch (error) {
      console.error('Error getting run count:', error);
      return 0;
    }
  }

  // Database maintenance methods
  optimize() {
    try {
      console.log('Running database optimization...');

      // Update query planner statistics
      this.db.exec('ANALYZE');

      // Optimize the database (SQLite 3.18.0+)
      // This rebuilds stats and considers index improvements
      this.db.exec('PRAGMA optimize');

      // Run incremental vacuum to reclaim space
      this.db.exec('PRAGMA incremental_vacuum');

      console.log('Database optimization complete');
    } catch (error) {
      console.error('Error during optimization:', error);
    }
  }

  getDbStats() {
    try {
      const stats = {
        pageCount: this.db.query('PRAGMA page_count').get() as {
          page_count: number;
        },
        pageSize: this.db.query('PRAGMA page_size').get() as {
          page_size: number;
        },
        cacheSize: this.db.query('PRAGMA cache_size').get() as {
          cache_size: number;
        },
        walMode: this.db.query('PRAGMA journal_mode').get() as {
          journal_mode: string;
        },
        integrityCheck: this.db.query('PRAGMA quick_check').get() as {
          quick_check: string;
        },
        freelist: this.db.query('PRAGMA freelist_count').get() as {
          freelist_count: number;
        },
      };

      const sizeInBytes = stats.pageCount.page_count * stats.pageSize.page_size;
      const sizeInMB = (sizeInBytes / 1024 / 1024).toFixed(2);

      return {
        ...stats,
        sizeInBytes,
        sizeInMB,
        cacheInMB: Math.abs(stats.cacheSize.cache_size) / 1000,
      };
    } catch (error) {
      console.error('Error getting database stats:', error);
      return null;
    }
  }

  // Check database integrity (returns true if OK, false if corrupted)
  checkIntegrity(): boolean {
    try {
      const result = this.db.query('PRAGMA integrity_check').all() as Array<{
        integrity_check: string;
      }>;
      const [firstResult] = result;
      const isOk = result.length === 1 && firstResult?.integrity_check === 'ok';

      if (!isOk) {
        console.error('Database integrity check failed:', result);
      }

      return isOk;
    } catch (error) {
      console.error('Error checking database integrity:', error);
      return false;
    }
  }

  // Create a backup of the database
  backup(backupPath?: string) {
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const path = backupPath || `./data/backups/amc-monitor-${timestamp}.db`;

      // Ensure backup directory exists
      const backupDir = './data/backups';
      if (!existsSync(backupDir)) {
        mkdirSync(backupDir, { recursive: true });
      }

      // Force a checkpoint to ensure all data is in main file
      this.db.exec('PRAGMA wal_checkpoint(FULL)');

      // Use SQLite's backup API
      this.db.exec(`VACUUM INTO '${path}'`);

      console.log(`Database backed up to: ${path}`);
      return path;
    } catch (error) {
      console.error('Error creating backup:', error);
      return null;
    }
  }

  // Run maintenance tasks (call this periodically, e.g., once a day)
  runMaintenance() {
    try {
      // Check integrity first - critical for safety
      if (!this.checkIntegrity()) {
        console.error(
          'Database integrity check failed! Creating backup and stopping maintenance.'
        );
        this.backup(`./data/backups/corrupted-${Date.now()}.db`);
        return;
      }

      const stats = this.getDbStats();
      console.log('Database stats before maintenance:', stats);

      // Create a backup before maintenance (safety first!)
      this.backup();

      // Clean up old logs (keep last 7 days)
      const cleanupStmt = this.db.prepare(`
        DELETE FROM logs
        WHERE datetime(timestamp) < datetime('now', '-7 days')
      `);
      const result = cleanupStmt.run();
      console.log(`Cleaned up ${result.changes} old log entries`);

      // Optimize the database
      this.optimize();

      // Checkpoint WAL file to keep it from growing too large
      // Use FULL mode for maximum safety during maintenance
      this.db.exec('PRAGMA wal_checkpoint(FULL)');

      const newStats = this.getDbStats();
      console.log('Database stats after maintenance:', newStats);
    } catch (error) {
      console.error('Error during maintenance:', error);
    }
  }

  isClosed(): boolean {
    return this.closed;
  }

  close() {
    if (this.closed) {
      return;
    }

    try {
      // Run optimization before closing (lightweight)
      this.db.exec('PRAGMA optimize');

      // Checkpoint the WAL file before closing to ensure all changes are written
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch (error) {
      console.error('Error during WAL checkpoint:', error);
    } finally {
      this.db.close();
      this.closed = true;
    }
  }
}
