import { Database } from 'bun:sqlite';

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
      movie.releaseDate,
      movie.mpaaRating,
      movie.runTime,
      movie.genre
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
        showtime.ticketUrl,
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
        showtime.ticketUrl
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
    data?: any
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

  close() {
    this.db.close();
  }
}
