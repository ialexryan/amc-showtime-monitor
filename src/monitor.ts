import { AMCApiClient, type AMCMovie } from './amc-api.js';
import type { AppConfig } from './config.js';
import {
  type Movie,
  type PendingNotification,
  ShowtimeDatabase,
  type Theatre,
  type WatchlistCandidate,
  type WatchlistEntry,
  type WorkerState,
} from './database.js';
import { getErrorMessage } from './errors.js';
import { Logger } from './logger.js';
import { formatShowtimeForLog } from './showtime-time.js';
import {
  STARTUP_NOTIFICATION_STATE_KEY,
  shouldSendStartupNotification,
} from './startup-notification.js';
import {
  TelegramBot,
  type TelegramCommandPollOptions,
  type TelegramInlineButton,
  type TelegramMessage,
  type TelegramUpdate,
} from './telegram.js';
import {
  buildAmbiguitySignature,
  createMovieResolutionContext,
  encodeWatchlistCallbackAction,
  findResolvedMovieVariants,
  normalizeWatchlistQuery,
  parseWatchlistCallbackAction,
  resolveWatchlistQuery,
} from './watchlist-resolution.js';

export class ShowtimeMonitor {
  private amcClient: AMCApiClient;
  private database: ShowtimeDatabase;
  private telegram: TelegramBot;
  private config: AppConfig;
  private logger: Logger;
  private theatre: Theatre | null = null;
  private closed = false;
  private lastSuccessfulCatalogFetchAt: Date | null = null;
  private lastSuccessfulCatalogMovieCount: number | null = null;

  constructor(config: AppConfig, dbPath?: string) {
    this.config = config;
    this.database = new ShowtimeDatabase(dbPath);
    this.logger = new Logger(this.database);
    this.amcClient = new AMCApiClient(config.amcApiKey, this.logger);
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

  async checkForNewShowtimes(signal?: AbortSignal): Promise<void> {
    if (!this.theatre) {
      throw new Error('Monitor not initialized. Call initialize() first.');
    }

    const memUsage = process.memoryUsage();
    this.logger.info(
      `🔍 Checking for new showtimes... (Memory: ${Math.round(memUsage.rss / 1024 / 1024)}MB RSS, ${Math.round(memUsage.heapUsed / 1024 / 1024)}MB heap)`
    );
    let newShowtimeCount = 0;

    // Fetch all movies once at the start
    const allMovies = await this.amcClient.getAllMovies(signal);
    this.recordSuccessfulCatalogFetch(allMovies.length);
    const resolutionContext = createMovieResolutionContext(allMovies);
    const memAfterFetch = process.memoryUsage();
    this.logger.info(
      `📊 After fetching ${allMovies.length} movies (Memory: ${Math.round(memAfterFetch.rss / 1024 / 1024)}MB RSS, ${Math.round(memAfterFetch.heapUsed / 1024 / 1024)}MB heap)`
    );

    const watchlistEntries = this.database.getWatchlistEntries();
    const unresolvedEntries = watchlistEntries.filter(
      (entry) => entry.resolutionState !== 'resolved'
    );

    for (const entry of unresolvedEntries) {
      try {
        await this.reconcileWatchlistEntry(entry, resolutionContext, true);
      } catch (error) {
        const message = getErrorMessage(error);
        this.logger.error(
          `❌ Error resolving watchlist entry "${entry.queryText}": ${message}`,
          { movie: entry.queryText }
        );
      }
    }

    const resolvedEntries = this.database.getResolvedWatchlistEntries();
    const processedResolvedMovieIds = new Set<number>();
    for (const entry of resolvedEntries) {
      try {
        const amcMovie = this.getResolvedWatchlistMovie(
          entry,
          resolutionContext
        );
        if (!amcMovie) {
          this.logger.warn(
            `⚠️ Skipping resolved entry without complete AMC metadata: ${entry.queryText}`,
            { movie: entry.queryText }
          );
          continue;
        }

        const relatedMovies = findResolvedMovieVariants(
          amcMovie,
          resolutionContext
        );
        const moviesToProcess = relatedMovies.filter((movie) => {
          if (processedResolvedMovieIds.has(movie.id)) {
            return false;
          }

          processedResolvedMovieIds.add(movie.id);
          return true;
        });

        if (moviesToProcess.length === 0) {
          continue;
        }

        if (moviesToProcess.length > 1) {
          const variantNames = moviesToProcess
            .slice(1)
            .map((movie) => movie.name)
            .join(', ');
          this.logger.info(
            `🔗 Including ${moviesToProcess.length - 1} variant AMC title${moviesToProcess.length === 2 ? '' : 's'} for "${entry.resolvedMovieName ?? entry.queryText}": ${variantNames}`,
            { movie: entry.resolvedMovieName ?? entry.queryText }
          );
        }

        for (const movie of moviesToProcess) {
          newShowtimeCount += await this.processMovieShowtimes(movie, signal);
        }
      } catch (error) {
        const message = getErrorMessage(error);
        this.logger.error(
          `❌ Error processing resolved entry "${entry.queryText}": ${message}`,
          { movie: entry.queryText }
        );
      }
    }

    const pendingNotifications = this.database.getPendingNotifications();

    if (pendingNotifications.length > 0) {
      await this.deliverPendingNotifications(pendingNotifications);
    } else {
      const emptyMessage =
        newShowtimeCount > 0
          ? '\n📭 No pending notifications to send'
          : '\n📭 No new showtimes found';
      this.logger.info(emptyMessage);
    }

    this.logger.info('🏁 Checking for new showtimes complete');
  }

  private async processMovieShowtimes(
    amcMovie: AMCMovie,
    signal?: AbortSignal
  ): Promise<number> {
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
      this.theatre.id,
      signal
    );

    this.logger.info(`   📅 Found ${amcShowtimes.length} showtimes`, {
      movie: amcMovie.name,
    });

    let newShowtimeCount = 0;

    // Process each showtime
    for (const amcShowtime of amcShowtimes) {
      const ticketUrl = this.amcClient.generateTicketUrl(amcShowtime);

      // Store showtime in database and check if it's new
      const result = this.database.upsertShowtime({
        movieId: movieId,
        theatreId: this.theatre.id,
        showDateTime: amcShowtime.showDateTimeUtc,
        showDateTimeLocal: amcShowtime.showDateTimeLocal,
        ...(amcShowtime.utcOffset !== undefined
          ? { utcOffset: amcShowtime.utcOffset }
          : {}),
        auditorium: amcShowtime.auditorium,
        isSoldOut: amcShowtime.isSoldOut,
        isAlmostSoldOut: amcShowtime.isAlmostSoldOut,
        attributes: JSON.stringify(amcShowtime.attributes || []),
        ticketUrl: ticketUrl,
      });

      // If this is a new showtime, create a notification
      if (result.isNew) {
        this.logger.info(
          `   🆕 New showtime: ${formatShowtimeForLog(
            amcShowtime.showDateTimeUtc,
            amcShowtime.showDateTimeLocal,
            amcShowtime.utcOffset
          )}`,
          { movie: amcMovie.name }
        );
        newShowtimeCount += 1;
      }
    }

    // Update movie's last checked time
    this.database.updateMovieLastChecked(movieId);

    if (newShowtimeCount > 0) {
      this.logger.info(
        `   ✨ ${newShowtimeCount} new showtimes for ${amcMovie.name}`,
        { movie: amcMovie.name }
      );
    }

    return newShowtimeCount;
  }

  private getResolvedWatchlistMovie(
    entry: WatchlistEntry,
    resolutionContext: ReturnType<typeof createMovieResolutionContext>
  ): AMCMovie | null {
    if (
      entry.resolvedMovieId === undefined ||
      entry.resolvedMovieSlug === undefined ||
      entry.resolvedMovieName === undefined
    ) {
      return null;
    }

    const catalogMovie = resolutionContext.moviesById.get(
      entry.resolvedMovieId
    );
    if (catalogMovie) {
      return catalogMovie;
    }

    return {
      id: entry.resolvedMovieId,
      name: entry.resolvedMovieName,
      slug: entry.resolvedMovieSlug,
    };
  }

  private async reconcileWatchlistEntry(
    entry: WatchlistEntry,
    resolutionContext: ReturnType<typeof createMovieResolutionContext>,
    promptOnAmbiguity: boolean
  ): Promise<
    | { kind: 'resolved'; entry: WatchlistEntry }
    | { kind: 'merged'; entry: WatchlistEntry }
    | {
        kind: 'ambiguous';
        entry: WatchlistEntry;
        candidates: WatchlistCandidate[];
      }
    | { kind: 'unmatched'; entry: WatchlistEntry }
  > {
    const checkedAt = new Date().toISOString();
    const resolution = resolveWatchlistQuery(
      entry.queryText,
      resolutionContext
    );

    if (resolution.state === 'resolved') {
      const existingResolvedEntry =
        this.database.getWatchlistEntryByResolvedMovieId(
          resolution.resolvedMovie.id
        );
      if (existingResolvedEntry && existingResolvedEntry.id !== entry.id) {
        this.database.deleteWatchlistEntry(entry.id);
        return {
          kind: 'merged',
          entry: existingResolvedEntry,
        };
      }

      const resolvedEntry = this.database.saveWatchlistEntryResolved(
        entry.id,
        {
          id: resolution.resolvedMovie.id,
          slug: resolution.resolvedMovie.slug,
          name: resolution.resolvedMovie.name,
        },
        checkedAt
      );

      return {
        kind: 'resolved',
        entry: resolvedEntry ?? entry,
      };
    }

    if (resolution.state === 'ambiguous') {
      const ambiguitySignature = buildAmbiguitySignature(resolution.candidates);
      const ambiguousEntry = this.database.saveWatchlistEntryAmbiguous(
        entry.id,
        JSON.stringify(resolution.candidates),
        ambiguitySignature,
        checkedAt
      );
      const nextEntry = ambiguousEntry ?? entry;

      if (
        promptOnAmbiguity &&
        (entry.resolutionState !== 'ambiguous' ||
          entry.ambiguitySignature !== ambiguitySignature ||
          entry.ambiguityPromptMessageId === undefined)
      ) {
        await this.sendAmbiguityPrompt(nextEntry, resolution.candidates);
      }

      return {
        kind: 'ambiguous',
        entry: nextEntry,
        candidates: resolution.candidates,
      };
    }

    const unmatchedEntry = this.database.saveWatchlistEntryUnmatched(
      entry.id,
      checkedAt
    );
    return {
      kind: 'unmatched',
      entry: unmatchedEntry ?? entry,
    };
  }

  private async sendAmbiguityPrompt(
    entry: WatchlistEntry,
    candidates: WatchlistCandidate[]
  ): Promise<void> {
    if (!entry.ambiguitySignature) {
      return;
    }

    try {
      const buttons = this.buildAmbiguityPromptButtons(
        entry.id,
        entry.ambiguitySignature,
        candidates
      );
      const message = this.buildAmbiguityPromptMessage(entry, candidates);
      const messageId = await this.telegram.sendOrEditInlinePrompt(
        message,
        buttons,
        entry.ambiguityPromptMessageId
      );

      this.database.updateWatchlistEntryPrompt(
        entry.id,
        entry.ambiguitySignature,
        messageId,
        new Date().toISOString()
      );
    } catch (error) {
      const message = getErrorMessage(error);
      this.database.clearWatchlistEntryPrompt(entry.id);
      this.logger.error(
        `❌ Failed to send ambiguity prompt for "${entry.queryText}": ${message}`,
        { movie: entry.queryText }
      );
    }
  }

  private buildAmbiguityPromptButtons(
    watchlistEntryId: number,
    ambiguitySignature: string,
    candidates: WatchlistCandidate[]
  ): TelegramInlineButton[] {
    const candidateButtons = candidates.slice(0, 3).map((candidate) => ({
      text: candidate.movieName,
      callbackData: encodeWatchlistCallbackAction({
        type: 'pick',
        watchlistEntryId,
        movieId: candidate.movieId,
        ambiguitySignature,
      }),
    }));

    return [
      ...candidateButtons,
      {
        text: 'Keep pending',
        callbackData: encodeWatchlistCallbackAction({
          type: 'keep',
          watchlistEntryId,
          ambiguitySignature,
        }),
      },
    ];
  }

  private buildAmbiguityPromptMessage(
    entry: WatchlistEntry,
    candidates: WatchlistCandidate[]
  ): string {
    const topCandidates = candidates.slice(0, 3);
    const candidateList = topCandidates
      .map((candidate, index) => {
        return `${index + 1}. ${this.escapeHtml(candidate.movieName)}`;
      })
      .join('\n');

    const summaryLine =
      candidates.length > 3
        ? `\n\nTop 3 of ${candidates.length} matches shown.`
        : '';

    return `🤔 <b>Multiple AMC matches for</b> "${this.escapeHtml(entry.queryText)}"

Tap the correct movie to track:
${candidateList}${summaryLine}

If none are right, tap <b>Keep pending</b>. I will only prompt again if the candidate set changes.`;
  }

  private async handleCallbackUpdate(
    update: Extract<TelegramUpdate, { type: 'callback' }>
  ): Promise<void> {
    const action = parseWatchlistCallbackAction(update.callbackData);
    if (!action) {
      await this.telegram.answerCallbackQuery(
        update.callbackQueryId,
        'That choice is no longer valid.'
      );
      return;
    }

    const entry = this.database.getWatchlistEntryById(action.watchlistEntryId);
    if (
      !entry ||
      entry.resolutionState !== 'ambiguous' ||
      !entry.ambiguitySignature ||
      entry.ambiguitySignature !== action.ambiguitySignature ||
      !entry.resolutionCandidatesJson
    ) {
      await this.telegram.answerCallbackQuery(
        update.callbackQueryId,
        'Those choices are stale. Wait for a new prompt.'
      );
      return;
    }

    if (action.type === 'keep') {
      await this.telegram.answerCallbackQuery(
        update.callbackQueryId,
        'Keeping it pending.'
      );
      return;
    }

    const candidates = this.parseWatchlistCandidates(
      entry.resolutionCandidatesJson
    );
    const selectedCandidate = candidates.find(
      (candidate) => candidate.movieId === action.movieId
    );

    if (!selectedCandidate) {
      await this.telegram.answerCallbackQuery(
        update.callbackQueryId,
        'Those choices are stale. Wait for a new prompt.'
      );
      return;
    }

    const existingResolvedEntry =
      this.database.getWatchlistEntryByResolvedMovieId(
        selectedCandidate.movieId
      );
    if (existingResolvedEntry && existingResolvedEntry.id !== entry.id) {
      this.database.deleteWatchlistEntry(entry.id);
      await this.telegram.answerCallbackQuery(
        update.callbackQueryId,
        'That movie is already tracked.'
      );
      await this.telegram.sendResponse(
        `⚠️ "${this.escapeHtml(selectedCandidate.movieName)}" is already in your watchlist.`
      );
      return;
    }

    const resolvedEntry = this.database.saveWatchlistEntryResolved(
      entry.id,
      {
        id: selectedCandidate.movieId,
        slug: selectedCandidate.movieSlug,
        name: selectedCandidate.movieName,
      },
      new Date().toISOString()
    );

    await this.telegram.answerCallbackQuery(
      update.callbackQueryId,
      `Tracking ${selectedCandidate.movieName}`
    );

    const resolvedName =
      resolvedEntry?.resolvedMovieName ?? selectedCandidate.movieName;
    await this.telegram.sendResponse(
      `✅ Resolved "${this.escapeHtml(entry.queryText)}" to "${this.escapeHtml(resolvedName)}".`
    );
  }

  private async deliverPendingNotifications(
    pendingNotifications: PendingNotification[]
  ): Promise<void> {
    this.logger.info(
      `\n📱 Sending ${pendingNotifications.length} pending notifications...`
    );

    const notificationsByMovie = new Map<string, PendingNotification[]>();
    for (const notification of pendingNotifications) {
      const movieNotifications =
        notificationsByMovie.get(notification.movieName) ?? [];
      movieNotifications.push(notification);
      notificationsByMovie.set(notification.movieName, movieNotifications);
    }

    let deliveredNotificationCount = 0;

    for (const [movieName, notifications] of notificationsByMovie.entries()) {
      const showtimeIds = notifications.map(
        (notification) => notification.showtimeId
      );
      const telegramMessages: TelegramMessage[] = notifications.map(
        (notification) => ({
          movieName: notification.movieName,
          theatreName: notification.theatreName,
          showDateTimeUtc: notification.showDateTimeUtc,
          showDateTimeLocal: notification.showDateTimeLocal,
          ...(notification.utcOffset !== undefined
            ? { utcOffset: notification.utcOffset }
            : {}),
          auditorium: notification.auditorium,
          attributes: this.parseNotificationAttributes(notification.attributes),
          ...(notification.ticketUrl !== undefined
            ? { ticketUrl: notification.ticketUrl }
            : {}),
          isSoldOut: notification.isSoldOut,
          isAlmostSoldOut: notification.isAlmostSoldOut,
        })
      );

      try {
        await this.telegram.sendMovieNotification(movieName, telegramMessages);
        this.database.markNotificationsDelivered(showtimeIds);
        deliveredNotificationCount += showtimeIds.length;
      } catch (error) {
        const message = getErrorMessage(error);
        this.logger.error(
          `❌ Failed to send notifications for "${movieName}": ${message}`,
          { movie: movieName }
        );
      }
    }

    if (deliveredNotificationCount > 0) {
      this.logger.info(
        `✅ Delivered ${deliveredNotificationCount} notifications successfully`
      );
    }
  }

  private parseNotificationAttributes(
    rawAttributes: string
  ): Array<{ code: string; name: string; description?: string }> {
    try {
      return JSON.parse(rawAttributes) as Array<{
        code: string;
        name: string;
        description?: string;
      }>;
    } catch {
      return [];
    }
  }

  private parseWatchlistCandidates(
    rawCandidates: string
  ): WatchlistCandidate[] {
    try {
      return JSON.parse(rawCandidates) as WatchlistCandidate[];
    } catch {
      return [];
    }
  }

  private escapeHtml(value: string): string {
    return value
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;');
  }

  private formatWatchlistEntryLabel(entry: WatchlistEntry): string {
    switch (entry.resolutionState) {
      case 'resolved':
        return entry.resolvedMovieName || entry.queryText;
      case 'ambiguous':
        return `${entry.queryText} (choose match)`;
      case 'unmatched':
        return `${entry.queryText} (pending)`;
      default:
        return `${entry.queryText} (pending)`;
    }
  }

  async sendTestNotification(): Promise<void> {
    this.logger.info('📱 Sending test notification...');
    await this.telegram.sendTestMessage();
  }

  async sendStartupNotification(workerId: string): Promise<void> {
    const theatreName = this.theatre?.name ?? this.config.theatre;
    const startedAt = new Date();
    const lastStartupNotificationAt = this.database.getBotState(
      STARTUP_NOTIFICATION_STATE_KEY
    );

    if (!shouldSendStartupNotification(lastStartupNotificationAt, startedAt)) {
      this.logger.info(
        `🔕 Suppressed startup notification; last sent at ${lastStartupNotificationAt}`
      );
      return;
    }

    const sent = await this.telegram.sendResponse(
      `🚀 <b>AMC Showtime Monitor started</b>

🏛️ ${this.escapeHtml(theatreName)}
🆔 <code>${this.escapeHtml(workerId)}</code>
🕒 ${this.escapeHtml(this.formatDisplayTimestamp(startedAt))}`
    );

    if (sent) {
      this.database.setBotState(
        STARTUP_NOTIFICATION_STATE_KEY,
        startedAt.toISOString()
      );
    }
  }

  async getStatus(): Promise<{
    theatre: Theatre | null;
    trackedMovies: string[];
    resolvedWatchlistEntries: number;
    ambiguousWatchlistEntries: number;
    pendingWatchlistEntries: number;
    unnotifiedShowtimes: number;
    lastSuccessfulCatalogFetch: string | null;
    runsLastHour: number;
    runsLast24Hours: number;
    workerState: WorkerState | null;
  }> {
    const startedAt = Date.now();
    const watchlistEntries = this.database.getWatchlistEntries();
    const theatre =
      this.theatre || this.database.getTheatreByName(this.config.theatre);
    const status = {
      theatre: theatre,
      trackedMovies: watchlistEntries.map((entry) =>
        this.formatWatchlistEntryLabel(entry)
      ),
      resolvedWatchlistEntries: watchlistEntries.filter(
        (entry) => entry.resolutionState === 'resolved'
      ).length,
      ambiguousWatchlistEntries: watchlistEntries.filter(
        (entry) => entry.resolutionState === 'ambiguous'
      ).length,
      pendingWatchlistEntries: watchlistEntries.filter(
        (entry) =>
          entry.resolutionState === 'pending' ||
          entry.resolutionState === 'unmatched'
      ).length,
      unnotifiedShowtimes: this.database.countUnnotifiedShowtimes(),
      lastSuccessfulCatalogFetch: this.formatLastSuccessfulCatalogFetch(),
      runsLastHour: this.database.getShowtimeCheckCountSince(1),
      runsLast24Hours: this.database.getShowtimeCheckCountSince(24),
      workerState: this.database.getWorkerState(),
    };

    this.logger.info(`📊 Built status snapshot in ${Date.now() - startedAt}ms`);

    return status;
  }

  flushLogs(): void {
    this.logger.flush();
  }

  getDatabase(): ShowtimeDatabase {
    return this.database;
  }

  getLogger(): Logger {
    return this.logger;
  }

  close(): void {
    if (this.closed) {
      return;
    }

    const memUsage = process.memoryUsage();
    this.logger.info(
      `🎉 Monitor run completed successfully (Final Memory: ${Math.round(memUsage.rss / 1024 / 1024)}MB RSS, ${Math.round(memUsage.heapUsed / 1024 / 1024)}MB heap)`
    );
    this.logger.flush();
    this.database.close();
    this.closed = true;
  }

  async processTelegramCommands(
    options: TelegramCommandPollOptions & { throwOnError?: boolean } = {}
  ): Promise<void> {
    const memUsage = process.memoryUsage();
    this.logger.info(
      `🔍 Checking for Telegram commands... (Memory: ${Math.round(memUsage.rss / 1024 / 1024)}MB RSS, ${Math.round(memUsage.heapUsed / 1024 / 1024)}MB heap)`
    );
    try {
      const updates = await this.telegram.getUpdates(options);

      for (const update of updates) {
        if (update.type === 'command') {
          this.logger.info(
            `📱 Processing command: ${update.command} ${update.args}`
          );

          switch (update.command) {
            case '/add':
              await this.handleAddCommand(update.args);
              break;
            case '/remove':
              await this.handleRemoveCommand(update.args);
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
                `❌ Unknown command: ${update.command}\n\nSend /help for available commands.`
              );
          }
          continue;
        }

        await this.handleCallbackUpdate(update);
      }
    } catch (error) {
      if (options.throwOnError) {
        throw error;
      }
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

    const queryText = movieName.trim();
    const normalizedQuery = normalizeWatchlistQuery(queryText);
    const { created, entry } = this.database.createOrGetWatchlistEntry(
      queryText,
      normalizedQuery
    );

    if (!entry) {
      await this.telegram.sendResponse(
        '❌ Failed to add that movie to your watchlist.'
      );
      return;
    }

    if (!created) {
      await this.telegram.sendResponse(
        `⚠️ "${this.escapeHtml(this.formatWatchlistEntryLabel(entry))}" is already in your watchlist.`
      );
      return;
    }

    try {
      const allMovies = await this.amcClient.getAllMovies();
      this.recordSuccessfulCatalogFetch(allMovies.length);
      const resolutionContext = createMovieResolutionContext(allMovies);
      const outcome = await this.reconcileWatchlistEntry(
        entry,
        resolutionContext,
        true
      );

      switch (outcome.kind) {
        case 'resolved':
          await this.telegram.sendResponse(
            `✅ Added "${this.escapeHtml(entry.queryText)}" to your watchlist as "${this.escapeHtml(outcome.entry.resolvedMovieName || entry.queryText)}".`
          );
          return;
        case 'merged':
          await this.telegram.sendResponse(
            `⚠️ "${this.escapeHtml(outcome.entry.resolvedMovieName || outcome.entry.queryText)}" is already in your watchlist.`
          );
          return;
        case 'ambiguous':
          await this.telegram.sendResponse(
            `🤔 Added "${this.escapeHtml(entry.queryText)}" to your watchlist.\n\nMultiple AMC matches exist, so pick one from the buttons in the prompt.`
          );
          return;
        case 'unmatched':
          await this.telegram.sendResponse(
            `✅ Added "${this.escapeHtml(entry.queryText)}" to your watchlist.\n\nAMC does not know that movie yet, so I will keep checking.`
          );
          return;
      }
    } catch (error) {
      const message = getErrorMessage(error);
      this.logger.error(
        `❌ Error resolving new watchlist entry "${entry.queryText}": ${message}`,
        { movie: entry.queryText }
      );
      await this.telegram.sendResponse(
        `✅ Added "${this.escapeHtml(entry.queryText)}" to your watchlist.\n\nAMC lookup failed right now, so I will keep trying in the background.`
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

    const queryText = movieName.trim();
    const watchlistEntries = this.database.getWatchlistEntries();
    const index = Number.parseInt(queryText, 10);

    let entryToRemove: WatchlistEntry | undefined;
    if (
      Number.isInteger(index) &&
      `${index}` === queryText &&
      index >= 1 &&
      index <= watchlistEntries.length
    ) {
      entryToRemove = watchlistEntries[index - 1];
    } else {
      const lowerQuery = queryText.toLowerCase();
      const matches = watchlistEntries.filter(
        (entry) =>
          entry.queryText.toLowerCase() === lowerQuery ||
          entry.resolvedMovieName?.toLowerCase() === lowerQuery
      );

      if (matches.length > 1) {
        await this.telegram.sendResponse(
          '⚠️ Multiple watchlist entries match that text. Use the number from /list.'
        );
        return;
      }

      const [singleMatch] = matches;
      entryToRemove = singleMatch;
    }

    if (entryToRemove && this.database.deleteWatchlistEntry(entryToRemove.id)) {
      await this.telegram.sendResponse(
        `✅ Removed "${this.escapeHtml(this.formatWatchlistEntryLabel(entryToRemove))}" from your watchlist.`
      );
    } else {
      await this.telegram.sendResponse(
        `⚠️ "${this.escapeHtml(queryText)}" was not found in your watchlist.`
      );
    }
  }

  private async handleListCommand(): Promise<void> {
    const watchlistEntries = this.database.getWatchlistEntries();

    if (watchlistEntries.length === 0) {
      await this.telegram.sendResponse(
        '📋 Your watchlist is empty.\n\nAdd movies with /add <movie name>'
      );
      return;
    }

    const movieList = watchlistEntries
      .map(
        (entry, index) =>
          `${index + 1}. ${this.escapeHtml(this.formatWatchlistEntryLabel(entry))}`
      )
      .join('\n');
    await this.telegram.sendResponse(
      `📋 <b>Your Watchlist</b>\n\n${movieList}\n\nUse /add or /remove to modify your list.`
    );
  }

  private async handleStatusCommand(): Promise<void> {
    const startedAt = Date.now();
    const status = await this.getStatus();

    let message = `📊 <b>AMC Showtime Monitor Status</b>\n\n`;
    message += `🏛️ <b>Theatre:</b> ${status.theatre?.name || 'Not configured'}\n`;
    message += `🎬 <b>Watchlist:</b> ${status.trackedMovies.length} movies\n`;
    message += `✅ <b>Resolved:</b> ${status.resolvedWatchlistEntries}\n`;
    message += `🤔 <b>Ambiguous:</b> ${status.ambiguousWatchlistEntries}\n`;
    message += `🕒 <b>Pending:</b> ${status.pendingWatchlistEntries}\n`;
    message += `📚 <b>AMC catalog:</b> ${status.lastSuccessfulCatalogFetch || 'No successful fetch yet'}\n`;
    message += `🔄 <b>Showtime checks:</b> ${status.runsLastHour} last hour, ${status.runsLast24Hours} last 24h\n`;
    if (status.workerState) {
      message += `⚙️ <b>Worker:</b> ${status.workerState.status}`;
      if (status.workerState.workerId) {
        message += ` (${status.workerState.workerId})`;
      }
      message += '\n';
    }

    if (status.trackedMovies.length > 0) {
      message += `\n<b>Tracked Movies:</b>\n`;
      status.trackedMovies.forEach((movie) => {
        message += `• ${this.escapeHtml(movie)}\n`;
      });
    }

    message += `\n📊 <b>Unnotified Showtimes:</b> ${status.unnotifiedShowtimes}`;

    await this.telegram.sendResponse(message);
    this.logger.info(`📤 Sent /status response in ${Date.now() - startedAt}ms`);
  }

  private async handleHelpCommand(): Promise<void> {
    const helpMessage = `🤖 <b>AMC Showtime Monitor Commands</b>

<b>/add &lt;movie name&gt;</b>
Add a movie to your watchlist
Example: /add Deadpool & Wolverine

<b>/remove &lt;movie name&gt;</b>
Remove a movie from your watchlist by title or /list number
Example: /remove Tron: Ares

<b>/list</b>
Show your current watchlist and entry states

<b>/status</b>
Show monitoring status and watchlist resolution counts

<b>/help</b>
Show this help message

<i>If AMC finds multiple possible matches for a pending entry, the bot will send inline buttons so you can pick the right one.</i>`;

    await this.telegram.sendResponse(helpMessage);
  }

  private recordSuccessfulCatalogFetch(movieCount: number): void {
    this.lastSuccessfulCatalogFetchAt = new Date();
    this.lastSuccessfulCatalogMovieCount = movieCount;
  }

  private formatLastSuccessfulCatalogFetch(): string | null {
    if (
      this.lastSuccessfulCatalogFetchAt === null ||
      this.lastSuccessfulCatalogMovieCount === null
    ) {
      return null;
    }

    return `${this.lastSuccessfulCatalogMovieCount} movies at ${this.formatDisplayTimestamp(this.lastSuccessfulCatalogFetchAt)}`;
  }

  private formatDisplayTimestamp(date: Date): string {
    return new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
      timeZoneName: 'short',
      timeZone: this.config.runtime.displayTimeZone,
    }).format(date);
  }
}
