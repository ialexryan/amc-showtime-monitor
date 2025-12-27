import Fuse from 'fuse.js';
import { AMCApiClient, type AMCMovie } from './amc-api.js';
import type { AppConfig } from './config.js';
import { type Movie, ShowtimeDatabase, type Theatre } from './database.js';
import { getErrorMessage } from './errors.js';
import { Logger } from './logger.js';
import { TelegramBot, type TelegramMessage } from './telegram.js';

export class ShowtimeMonitor {
  private amcClient: AMCApiClient;
  private database: ShowtimeDatabase;
  private telegram: TelegramBot;
  private config: AppConfig;
  private logger: Logger;
  private theatre: Theatre | null = null;

  constructor(config: AppConfig, dbPath?: string) {
    this.config = config;
    this.amcClient = new AMCApiClient(config.amcApiKey);
    this.database = new ShowtimeDatabase(dbPath);
    this.logger = new Logger(this.database);
    this.telegram = new TelegramBot(
      config.telegram.botToken,
      config.telegram.chatId,
      this.database,
      this.logger
    );
  }

  async initialize(): Promise<void> {
    const memUsage = process.memoryUsage();
    this.logger.info(
      `🚀 Initializing AMC Showtime Monitor... (Memory: ${Math.round(memUsage.rss / 1024 / 1024)}MB RSS, ${Math.round(memUsage.heapUsed / 1024 / 1024)}MB heap)`
    );

    // Check if theatre is already cached in database
    let theatre = this.database.getTheatreByName(this.config.theatre);

    if (!theatre) {
      // Theatre not in cache, fetch from AMC API
      const amcTheatre = await this.amcClient.findTheatreByName(
        this.config.theatre
      );
      if (!amcTheatre) {
        throw new Error(`Theatre not found: ${this.config.theatre}`);
      }

      // Store theatre in database for future use
      const theatreData = {
        id: amcTheatre.id,
        name: amcTheatre.name,
        slug: amcTheatre.slug,
        location: `${amcTheatre.location.city}, ${amcTheatre.location.state}`,
      };

      this.database.upsertTheatre(theatreData);
      theatre = theatreData;
    }

    this.theatre = theatre;

    this.logger.info(
      `✅ Theatre found: ${this.theatre.name} (ID: ${this.theatre.id})`,
      { theatre: this.theatre.name }
    );

    // Test Telegram connection
    const telegramConnected = await this.telegram.testConnection();
    if (!telegramConnected) {
      throw new Error('Failed to connect to Telegram bot');
    }

    this.logger.info('✅ Initialization complete');
  }

  async checkForNewShowtimes(): Promise<void> {
    if (!this.theatre) {
      throw new Error('Monitor not initialized. Call initialize() first.');
    }

    const memUsage = process.memoryUsage();
    this.logger.info(
      `🔍 Checking for new showtimes... (Memory: ${Math.round(memUsage.rss / 1024 / 1024)}MB RSS, ${Math.round(memUsage.heapUsed / 1024 / 1024)}MB heap)`
    );
    const newNotifications: TelegramMessage[] = [];

    // Get watchlist from database
    const watchlist = this.database.getWatchlist();
    const moviesToCheck = watchlist;

    // Fetch all movies once at the start
    const allMovies = await this.amcClient.getAllMovies();
    const memAfterFetch = process.memoryUsage();
    this.logger.info(
      `📊 After fetching ${allMovies.length} movies (Memory: ${Math.round(memAfterFetch.rss / 1024 / 1024)}MB RSS, ${Math.round(memAfterFetch.heapUsed / 1024 / 1024)}MB heap)`
    );

    for (const movieName of moviesToCheck) {
      try {
        this.logger.info(`\n📽️  Processing: ${movieName}`, { movie: movieName });

        // Use fuzzy matching to find relevant movies from cached data
        const relevantMovies = this.filterRelevantMovies(allMovies, movieName);

        if (relevantMovies.length === 0) {
          this.logger.warn(`   ⚠️  No relevant movies found for: ${movieName}`, {
            movie: movieName,
          });
          continue;
        }

        this.logger.info(
          `   ✅ Found ${relevantMovies.length} relevant movies`,
          { movie: movieName }
        );

        // Check showtimes for each relevant movie
        for (const amcMovie of relevantMovies) {
          const notifications = await this.processMovieShowtimes(amcMovie);
          newNotifications.push(...notifications);
        }
      } catch (error) {
        const message = getErrorMessage(error);
        this.logger.error(
          `❌ Error processing movie "${movieName}": ${message}`,
          { movie: movieName }
        );
        // Continue with other movies instead of failing completely
      }
    }

    // Send notifications for new showtimes
    if (newNotifications.length > 0) {
      this.logger.info(
        `\n📱 Sending ${newNotifications.length} notifications...`
      );
      try {
        await this.telegram.sendBatchNotification(newNotifications);

        // Mark all notified showtimes as sent
        for (const _notification of newNotifications) {
          // We'd need to track the showtime ID in the notification to mark it
          // This is handled in processMovieShowtimes when we create notifications
        }

        this.logger.info('✅ All notifications sent successfully');
      } catch (error) {
        const message = getErrorMessage(error);
        this.logger.error(`❌ Failed to send notifications: ${message}`);
      }
    } else {
      this.logger.info('\n📭 No new showtimes found');
    }

    this.logger.info('🏁 Checking for new showtimes complete');
  }

  private filterRelevantMovies(
    movies: AMCMovie[],
    searchTerm: string
  ): AMCMovie[] {
    // Use fuzzy search to find movies that closely match our search term
    const fuse = new Fuse(movies, {
      keys: ['name'],
      threshold: 0.4, // Balanced threshold for reasonable matching
      includeScore: true,
    });

    const results = fuse.search(searchTerm);

    this.logger.info(
      `   🔍 Fuzzy search results for "${searchTerm}": ${results.map((r) => `${r.item.name} (score: ${r.score?.toFixed(3)})`).join(', ')}`
    );

    // Return movies with good similarity scores - be more strict
    const filteredResults = results.filter(
      (result) => (result.score ?? 1) < 0.4
    );

    if (filteredResults.length > 0) {
      this.logger.info(
        `   ✅ Found ${filteredResults.length} fuzzy matches with good scores`
      );
    } else {
      this.logger.warn(`   ⚠️  No good fuzzy matches found (scores too low)`);
    }

    return filteredResults.map((result) => result.item);
  }

  private async processMovieShowtimes(
    amcMovie: AMCMovie
  ): Promise<TelegramMessage[]> {
    if (!this.theatre) {
      throw new Error('Theatre not set');
    }

    this.logger.info(`   🎬 Processing showtimes for: ${amcMovie.name}`, {
      movie: amcMovie.name,
    });

    // Store/update movie in database
    const moviePayload: Omit<Movie, 'id' | 'lastChecked'> = {
      name: amcMovie.name,
      slug: amcMovie.slug,
    };
    if (amcMovie.releaseDateUtc !== undefined) {
      moviePayload.releaseDate = amcMovie.releaseDateUtc;
    }
    if (amcMovie.mpaaRating !== undefined) {
      moviePayload.mpaaRating = amcMovie.mpaaRating;
    }
    if (amcMovie.runTime !== undefined) {
      moviePayload.runTime = amcMovie.runTime;
    }
    if (amcMovie.genre !== undefined) {
      moviePayload.genre = amcMovie.genre;
    }

    const movieId = this.database.upsertMovie(moviePayload);

    // Get current showtimes for this movie at our theatre
    const amcShowtimes = await this.amcClient.getShowtimesForMovieAtTheatre(
      amcMovie.id,
      this.theatre.id
    );

    this.logger.info(`   📅 Found ${amcShowtimes.length} showtimes`, {
      movie: amcMovie.name,
    });

    const newNotifications: TelegramMessage[] = [];

    // Process each showtime
    for (const amcShowtime of amcShowtimes) {
      const ticketUrl = this.amcClient.generateTicketUrl(amcShowtime);

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
        this.logger.info(
          `   🆕 New showtime: ${new Date(amcShowtime.showDateTimeLocal).toLocaleString()}`,
          { movie: amcMovie.name }
        );

        newNotifications.push({
          movieName: amcMovie.name,
          theatreName: this.theatre.name,
          showDateTime: amcShowtime.showDateTimeUtc,
          showDateTimeLocal: amcShowtime.showDateTimeLocal,
          auditorium: amcShowtime.auditorium,
          attributes: amcShowtime.attributes || [],
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
      this.logger.info(
        `   ✨ ${newNotifications.length} new showtimes for ${amcMovie.name}`,
        { movie: amcMovie.name }
      );
    }

    return newNotifications;
  }

  async sendTestNotification(): Promise<void> {
    this.logger.info('📱 Sending test notification...');
    await this.telegram.sendTestMessage();
  }

  async getStatus(): Promise<{
    theatre: Theatre | null;
    trackedMovies: string[];
    totalShowtimes: number;
    unnotifiedShowtimes: number;
    runsLastHour: number;
    runsLast24Hours: number;
  }> {
    const unnotifiedShowtimes = this.database.getUnnotifiedShowtimes();
    const watchlist = this.database.getWatchlist();

    return {
      theatre: this.theatre,
      trackedMovies: watchlist,
      totalShowtimes: 0, // Could add a method to get this count
      unnotifiedShowtimes: unnotifiedShowtimes.length,
      runsLastHour: this.database.getRunCountSince(1),
      runsLast24Hours: this.database.getRunCountSince(24),
    };
  }

  close(): void {
    const memUsage = process.memoryUsage();
    this.logger.info(
      `🎉 Monitor run completed successfully (Final Memory: ${Math.round(memUsage.rss / 1024 / 1024)}MB RSS, ${Math.round(memUsage.heapUsed / 1024 / 1024)}MB heap)`
    );
    this.logger.flush();
    this.database.close();
  }

  async processTelegramCommands(): Promise<void> {
    const memUsage = process.memoryUsage();
    this.logger.info(
      `🔍 Checking for Telegram commands... (Memory: ${Math.round(memUsage.rss / 1024 / 1024)}MB RSS, ${Math.round(memUsage.heapUsed / 1024 / 1024)}MB heap)`
    );
    try {
      const commands = await this.telegram.checkForCommands();

      for (const { command, args } of commands) {
        this.logger.info(`📱 Processing command: ${command} ${args}`);

        switch (command) {
          case '/add':
            await this.handleAddCommand(args);
            break;
          case '/remove':
            await this.handleRemoveCommand(args);
            break;
          case '/list':
            await this.handleListCommand();
            break;
          case '/status':
            await this.handleStatusCommand();
            break;
          case '/help':
            await this.handleHelpCommand();
            break;
          default:
            await this.telegram.sendResponse(
              `❌ Unknown command: ${command}\n\nSend /help for available commands.`
            );
        }
      }
    } catch (error) {
      const message = getErrorMessage(error);
      this.logger.error(`❌ Error processing Telegram commands: ${message}`);
    }
    this.logger.info('🏁 Checking for Telegram commands complete');
  }

  private async handleAddCommand(movieName: string): Promise<void> {
    if (!movieName.trim()) {
      await this.telegram.sendResponse(
        '❌ Please specify a movie name.\n\nExample: /add Deadpool & Wolverine'
      );
      return;
    }

    const added = this.database.addToWatchlist(movieName.trim());
    if (added) {
      await this.telegram.sendResponse(
        `✅ Added "${movieName}" to your watchlist.`
      );
    } else {
      await this.telegram.sendResponse(
        `⚠️ "${movieName}" is already in your watchlist.`
      );
    }
  }

  private async handleRemoveCommand(movieName: string): Promise<void> {
    if (!movieName.trim()) {
      await this.telegram.sendResponse(
        '❌ Please specify a movie name.\n\nExample: /remove Tron: Ares'
      );
      return;
    }

    const removed = this.database.removeFromWatchlist(movieName.trim());
    if (removed) {
      await this.telegram.sendResponse(
        `✅ Removed "${movieName}" from your watchlist.`
      );
    } else {
      await this.telegram.sendResponse(
        `⚠️ "${movieName}" was not found in your watchlist.`
      );
    }
  }

  private async handleListCommand(): Promise<void> {
    const watchlist = this.database.getWatchlist();

    if (watchlist.length === 0) {
      await this.telegram.sendResponse(
        '📋 Your watchlist is empty.\n\nAdd movies with /add <movie name>'
      );
      return;
    }

    const movieList = watchlist
      .map((movie, index) => `${index + 1}. ${movie}`)
      .join('\n');
    await this.telegram.sendResponse(
      `📋 <b>Your Watchlist</b>\n\n${movieList}\n\nUse /add or /remove to modify your list.`
    );
  }

  private async handleStatusCommand(): Promise<void> {
    const status = await this.getStatus();
    const watchlist = this.database.getWatchlist();

    let message = `📊 <b>AMC Showtime Monitor Status</b>\n\n`;
    message += `🏛️ <b>Theatre:</b> ${status.theatre?.name || 'Not configured'}\n`;
    message += `🎬 <b>Watchlist:</b> ${watchlist.length} movies\n`;
    message += `🔄 <b>Checks:</b> ${status.runsLastHour} last hour, ${status.runsLast24Hours} last 24h\n`;

    if (watchlist.length > 0) {
      message += `\n<b>Tracked Movies:</b>\n`;
      watchlist.forEach((movie) => {
        message += `• ${movie}\n`;
      });
    }

    message += `\n📊 <b>Unnotified Showtimes:</b> ${status.unnotifiedShowtimes}`;

    await this.telegram.sendResponse(message);
  }

  private async handleHelpCommand(): Promise<void> {
    const helpMessage = `🤖 <b>AMC Showtime Monitor Commands</b>

<b>/add &lt;movie name&gt;</b>
Add a movie to your watchlist
Example: /add Deadpool & Wolverine

<b>/remove &lt;movie name&gt;</b>
Remove a movie from your watchlist
Example: /remove Tron: Ares

<b>/list</b>
Show your current watchlist

<b>/status</b>
Show monitoring status and statistics

<b>/help</b>
Show this help message

<i>The bot checks for new showtimes continuously and will notify you when tickets become available!</i>`;

    await this.telegram.sendResponse(helpMessage);
  }
}
