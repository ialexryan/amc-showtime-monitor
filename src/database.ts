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

export class ShowtimeDatabase {
  private db: Database;

  constructor(dbPath: string = './amc-monitor.db') {
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

  isInWatchlist(movieName: string): boolean {
    try {
      const stmt = this.db.prepare(`
        SELECT 1 FROM watchlist WHERE movie_name = ? COLLATE NOCASE
      `);
      return !!stmt.get(movieName);
    } catch (error) {
      console.error('Error checking watchlist:', error);
      return false;
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

  getRecentLogs(limit: number = 100): Array<{
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
        ORDER BY timestamp DESC 
        LIMIT ?
      `);
      return stmt.all(limit) as Array<{
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
      console.error('Error getting recent logs:', error);
      return [];
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

  close() {
    try {
      // Run optimization before closing (lightweight)
      this.db.exec('PRAGMA optimize');

      // Checkpoint the WAL file before closing to ensure all changes are written
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch (error) {
      console.error('Error during WAL checkpoint:', error);
    } finally {
      this.db.close();
    }
  }
}
