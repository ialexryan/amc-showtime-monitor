import Database from 'better-sqlite3';

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
  private db: Database.Database;

  constructor(dbPath: string = './showtimes.db') {
    this.db = new Database(dbPath);
    this.initTables();
  }

  private initTables() {
    // Create tables with proper indexes
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS theatres (
        id INTEGER PRIMARY KEY,
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

      -- Indexes for performance
      CREATE INDEX IF NOT EXISTS idx_showtimes_movie_theatre ON showtimes (movie_id, theatre_id);
      CREATE INDEX IF NOT EXISTS idx_showtimes_notified ON showtimes (notified);
      CREATE INDEX IF NOT EXISTS idx_showtimes_first_seen ON showtimes (first_seen);
      CREATE INDEX IF NOT EXISTS idx_movies_last_checked ON movies (last_checked);
    `);
  }

  // Theatre operations
  upsertTheatre(theatre: Omit<Theatre, 'id'>): number {
    const stmt = this.db.prepare(`
      INSERT INTO theatres (name, slug, location) 
      VALUES (?, ?, ?)
      ON CONFLICT(slug) DO UPDATE SET
        name = excluded.name,
        location = excluded.location
      RETURNING id
    `);
    const result = stmt.get(theatre.name, theatre.slug, theatre.location) as {
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
      return { id: result.lastInsertRowid as number, isNew: true };
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

  close() {
    this.db.close();
  }
}
