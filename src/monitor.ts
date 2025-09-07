import Fuse from 'fuse.js';
import { AMCApiClient, type AMCMovie } from './amc-api.js';
import type { AppConfig } from './config.js';
import { ShowtimeDatabase, type Theatre } from './database.js';
import { TelegramBot, type TelegramMessage } from './telegram.js';

export class ShowtimeMonitor {
  private amcClient: AMCApiClient;
  private database: ShowtimeDatabase;
  private telegram: TelegramBot;
  private config: AppConfig;
  private theatre: Theatre | null = null;

  constructor(config: AppConfig, dbPath?: string) {
    this.config = config;
    this.amcClient = new AMCApiClient(config.amcApiKey);
    this.database = new ShowtimeDatabase(dbPath);
    this.telegram = new TelegramBot(
      config.telegram.botToken,
      config.telegram.chatId
    );
  }

  async initialize(): Promise<void> {
    console.log('🚀 Initializing AMC Showtime Monitor...');

    // Find and cache the theatre
    const amcTheatre = await this.amcClient.findTheatreByName(
      this.config.theatre
    );
    if (!amcTheatre) {
      throw new Error(`Theatre not found: ${this.config.theatre}`);
    }

    // Store theatre in database using AMC's theatre ID
    const theatreData = {
      id: amcTheatre.id,
      name: amcTheatre.name,
      slug: amcTheatre.slug,
      location: `${amcTheatre.location.city}, ${amcTheatre.location.state}`,
    };

    this.database.upsertTheatre(theatreData);
    this.theatre = theatreData;

    console.log(
      `✅ Theatre found: ${this.theatre.name} (ID: ${this.theatre.id})`
    );

    // Test Telegram connection
    const telegramConnected = await this.telegram.testConnection();
    if (!telegramConnected) {
      throw new Error('Failed to connect to Telegram bot');
    }

    console.log('✅ Initialization complete');
  }

  async checkForNewShowtimes(): Promise<void> {
    if (!this.theatre) {
      throw new Error('Monitor not initialized. Call initialize() first.');
    }

    console.log('🔍 Checking for new showtimes...');
    const newNotifications: TelegramMessage[] = [];

    for (const movieName of this.config.movies) {
      try {
        console.log(`\n📽️  Processing: ${movieName}`);

        // Search for movies matching this name
        const amcMovies = await this.amcClient.searchMoviesByName(movieName);

        if (amcMovies.length === 0) {
          console.log(`   ⚠️  No movies found for: ${movieName}`);
          continue;
        }

        // Use fuzzy matching to find the best matches for the configured movie name
        const relevantMovies = this.filterRelevantMovies(amcMovies, movieName);

        if (relevantMovies.length === 0) {
          console.log(`   ⚠️  No relevant movies found for: ${movieName}`);
          continue;
        }

        console.log(`   ✅ Found ${relevantMovies.length} relevant movies`);

        // Check showtimes for each relevant movie
        for (const amcMovie of relevantMovies) {
          const notifications = await this.processMovieShowtimes(amcMovie);
          newNotifications.push(...notifications);
        }
      } catch (error) {
        console.error(
          `❌ Error processing movie "${movieName}":`,
          error.message
        );
        // Continue with other movies instead of failing completely
      }
    }

    // Send notifications for new showtimes
    if (newNotifications.length > 0) {
      console.log(`\n📱 Sending ${newNotifications.length} notifications...`);
      try {
        await this.telegram.sendBatchNotification(newNotifications);

        // Mark all notified showtimes as sent
        for (const _notification of newNotifications) {
          // We'd need to track the showtime ID in the notification to mark it
          // This is handled in processMovieShowtimes when we create notifications
        }

        console.log('✅ All notifications sent successfully');
      } catch (error) {
        console.error('❌ Failed to send notifications:', error.message);
      }
    } else {
      console.log('\n📭 No new showtimes found');
    }

    console.log('🏁 Check complete');
  }

  private filterRelevantMovies(
    movies: AMCMovie[],
    searchTerm: string
  ): AMCMovie[] {
    // Use fuzzy search to find movies that closely match our search term
    const fuse = new Fuse(movies, {
      keys: ['name'],
      threshold: 0.4, // Allow some fuzziness for variations like "Special Edition", etc.
      includeScore: true,
    });

    const results = fuse.search(searchTerm);

    // Return movies with good similarity scores
    return results
      .filter((result) => (result.score ?? 1) < 0.5) // Only reasonably close matches
      .map((result) => result.item);
  }

  private async processMovieShowtimes(
    amcMovie: AMCMovie
  ): Promise<TelegramMessage[]> {
    if (!this.theatre) {
      throw new Error('Theatre not set');
    }

    console.log(`   🎬 Processing showtimes for: ${amcMovie.name}`);

    // Store/update movie in database
    const movieId = this.database.upsertMovie({
      name: amcMovie.name,
      slug: amcMovie.slug,
      releaseDate: amcMovie.releaseDateUtc,
      mpaaRating: amcMovie.mpaaRating,
      runTime: amcMovie.runTime,
      genre: amcMovie.genre,
    });

    // Get current showtimes for this movie at our theatre
    const amcShowtimes = await this.amcClient.getShowtimesForMovieAtTheatre(
      amcMovie.id,
      this.theatre.id
    );

    console.log(`   📅 Found ${amcShowtimes.length} showtimes`);

    const newNotifications: TelegramMessage[] = [];

    // Process each showtime
    for (const amcShowtime of amcShowtimes) {
      const ticketUrl = this.amcClient.generateTicketUrl(
        amcShowtime,
        this.theatre.slug
      );

      // Store showtime in database and check if it's new
      const result = this.database.upsertShowtime({
        movieId: movieId,
        theatreId: this.theatre.id,
        showDateTime: amcShowtime.showDateTimeUtc,
        showDateTimeLocal: amcShowtime.showDateTimeLocal,
        auditorium: amcShowtime.auditorium,
        isSoldOut: amcShowtime.isSoldOut,
        isAlmostSoldOut: amcShowtime.isAlmostSoldOut,
        attributes: JSON.stringify(amcShowtime.attributes || []),
        ticketUrl: ticketUrl,
      });

      // If this is a new showtime, create a notification
      if (result.isNew) {
        console.log(
          `   🆕 New showtime: ${new Date(amcShowtime.showDateTimeLocal).toLocaleString()}`
        );

        newNotifications.push({
          movieName: amcMovie.name,
          theatreName: this.theatre.name,
          showDateTime: amcShowtime.showDateTimeUtc,
          showDateTimeLocal: amcShowtime.showDateTimeLocal,
          auditorium: amcShowtime.auditorium,
          attributes: amcShowtime.attributes?.map((attr) => attr.name) || [],
          ticketUrl: ticketUrl,
          isSoldOut: amcShowtime.isSoldOut,
          isAlmostSoldOut: amcShowtime.isAlmostSoldOut,
        });

        // Mark this showtime as notified (we'll send the notification shortly)
        this.database.markShowtimeNotified(result.id);
      }
    }

    // Update movie's last checked time
    this.database.updateMovieLastChecked(movieId);

    if (newNotifications.length > 0) {
      console.log(
        `   ✨ ${newNotifications.length} new showtimes for ${amcMovie.name}`
      );
    }

    return newNotifications;
  }

  async sendTestNotification(): Promise<void> {
    console.log('📱 Sending test notification...');
    await this.telegram.sendTestMessage();
  }

  async getStatus(): Promise<{
    theatre: Theatre | null;
    trackedMovies: string[];
    totalShowtimes: number;
    unnotifiedShowtimes: number;
  }> {
    const unnotifiedShowtimes = this.database.getUnnotifiedShowtimes();

    return {
      theatre: this.theatre,
      trackedMovies: this.config.movies,
      totalShowtimes: 0, // Could add a method to get this count
      unnotifiedShowtimes: unnotifiedShowtimes.length,
    };
  }

  close(): void {
    this.database.close();
  }
}
