import axios, { type AxiosInstance } from 'axios';
import type { ShowtimeDatabase } from './database.js';
import { getErrorMessage } from './errors.js';
import type { Logger } from './logger.js';
import {
  formatShowtimeDate,
  formatShowtimeTime,
  getShowtimeSortTimeMs,
} from './showtime-time.js';

export interface TelegramMessage {
  movieName: string;
  theatreName: string;
  showDateTimeUtc: string;
  showDateTimeLocal: string;
  utcOffset?: string;
  auditorium: number;
  attributes: Array<{ code: string; name: string; description?: string }>;
  ticketUrl?: string;
  isSoldOut: boolean;
  isAlmostSoldOut: boolean;
}

export interface TelegramCommandPollOptions {
  timeoutSeconds?: number;
  signal?: AbortSignal;
}

export class TelegramBot {
  private client: AxiosInstance;
  private lastUpdateId: number = 0;
  private readonly defaultTimeoutMs = 10_000;

  constructor(
    botToken: string,
    private chatId: string,
    private database?: ShowtimeDatabase,
    private logger?: Logger
  ) {
    this.client = axios.create({
      baseURL: `https://api.telegram.org/bot${botToken}`,
      timeout: this.defaultTimeoutMs,
    });

    // Load last update ID from database
    if (this.database) {
      const lastId = this.database.getBotState('last_update_id');
      this.lastUpdateId = lastId ? parseInt(lastId, 10) : 0;
    }
  }

  async sendBatchNotification(messages: TelegramMessage[]): Promise<void> {
    if (messages.length === 0) return;

    // Group messages by movie for cleaner batch notifications
    const movieGroups = new Map<string, TelegramMessage[]>();
    messages.forEach((msg) => {
      const key = msg.movieName;
      if (!movieGroups.has(key)) {
        movieGroups.set(key, []);
      }
      movieGroups.get(key)?.push(msg);
    });

    for (const [movieName, movieMessages] of movieGroups) {
      const batchMessage = this.formatBatchMessage(movieName, movieMessages);
      if (!batchMessage) {
        continue;
      }

      try {
        await this.client.post('/sendMessage', {
          chat_id: this.chatId,
          text: batchMessage,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        });

        this.logger?.info(
          `✅ Batch notification sent for ${movieName} (${movieMessages.length} showtimes)`,
          { movie: movieName }
        );

        // Small delay between messages to avoid rate limiting
        if (movieGroups.size > 1) {
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      } catch (error) {
        const message = getErrorMessage(error);
        this.logger?.error(
          `❌ Failed to send batch notification for ${movieName}: ${message}`,
          { movie: movieName }
        );
        throw error;
      }
    }
  }

  private formatBatchMessage(
    movieName: string,
    messages: TelegramMessage[]
  ): string {
    const [firstMessage] = messages;
    if (!firstMessage) {
      return '';
    }

    const sortedMessages = messages.sort(
      (a, b) =>
        getShowtimeSortTimeMs(
          a.showDateTimeUtc,
          a.showDateTimeLocal,
          a.utcOffset
        ) -
        getShowtimeSortTimeMs(
          b.showDateTimeUtc,
          b.showDateTimeLocal,
          b.utcOffset
        )
    );

    const showtimeList = sortedMessages
      .map((msg) => {
        const dateStr = formatShowtimeDate(
          msg.showDateTimeUtc,
          msg.showDateTimeLocal,
          msg.utcOffset
        );
        const timeStr = formatShowtimeTime(
          msg.showDateTimeUtc,
          msg.showDateTimeLocal,
          msg.utcOffset
        );

        const formatStr = this.getFormatString(msg.attributes);

        let statusEmoji = '🎬';
        if (msg.isSoldOut) statusEmoji = '❌';
        else if (msg.isAlmostSoldOut) statusEmoji = '⚠️';

        const showtimeText = `${statusEmoji} ${dateStr} ${timeStr}${formatStr ? ` - ${formatStr}` : ` - Aud ${msg.auditorium}`}`;
        return msg.ticketUrl
          ? `<a href="${msg.ticketUrl}">${showtimeText}</a>`
          : showtimeText;
      })
      .join('\n');

    const showtimeCount =
      messages.length === 1
        ? 'New Showtime'
        : `${messages.length} New Showtimes`;

    return `🎬 <b>${showtimeCount} for ${movieName}!</b>

🏛️ ${firstMessage.theatreName}

${showtimeList}`;
  }

  private getFormatString(
    attributes: Array<{ code: string; name: string }>
  ): string {
    // Priority order for premium formats (most premium first)
    const premiumFormats = [
      'IMAXWITHLASER3D',
      'IMAXWITHLASERATAMC',
      'DOLBYCINEMAATAMCPRIME',
      'DOLBYCINEMAATAMC',
      'IMAX',
      'DOLBY3D',
      'LASERATAMC',
      'REALD3D',
      'DBOX',
      'DOLBYATMOS',
    ];

    for (const format of premiumFormats) {
      const found = attributes.find(
        (attr) => attr.code.toUpperCase() === format
      );
      if (found) {
        return found.name.replace(/ at AMC$/, '');
      }
    }

    // Look for other notable premium attributes
    const otherFormats = attributes.filter(
      (attr) =>
        attr.code.includes('PREMIUM') ||
        attr.code.includes('LUXURY') ||
        attr.code.includes('3D') ||
        attr.name.includes('Premium')
    );

    const [firstFormat] = otherFormats;
    if (firstFormat) {
      return firstFormat.name.replace(/ at AMC$/, '');
    }

    return '';
  }

  // Test the connection and get bot info
  async testConnection(): Promise<boolean> {
    try {
      const response = await this.client.get('/getMe');
      this.logger?.info(
        `✅ Telegram bot connected: ${response.data.result.username}`
      );
      return true;
    } catch (error) {
      const message = getErrorMessage(error);
      this.logger?.error(`❌ Failed to connect to Telegram bot: ${message}`);
      return false;
    }
  }

  // Send a test message
  async sendTestMessage(): Promise<void> {
    const testMessage = `🤖 <b>AMC Showtime Monitor Test</b>

This is a test message to verify your Telegram bot is working correctly.

Time: ${new Date().toLocaleString()}`;

    try {
      await this.client.post('/sendMessage', {
        chat_id: this.chatId,
        text: testMessage,
        parse_mode: 'HTML',
      });

      this.logger?.info('✅ Test message sent successfully');
    } catch (error) {
      const message = getErrorMessage(error);
      this.logger?.error(`❌ Failed to send test message: ${message}`);
      throw error;
    }
  }

  // Check for new messages and return commands
  async checkForCommands(
    options: TelegramCommandPollOptions = {}
  ): Promise<Array<{ command: string; args: string }>> {
    const longPollTimeoutSeconds = options.timeoutSeconds ?? 0;
    const requestTimeoutMs = Math.max(
      this.defaultTimeoutMs,
      (longPollTimeoutSeconds + 10) * 1000
    );
    const requestConfig = {
      params: {
        offset: this.lastUpdateId + 1,
        limit: 20,
        timeout: longPollTimeoutSeconds,
        allowed_updates: ['message'], // Only message updates, not other types
      },
      timeout: requestTimeoutMs,
      ...(options.signal ? { signal: options.signal } : {}),
    };

    const response = await this.client.get('/getUpdates', requestConfig);
    const updates = response.data.result;
    const commands: Array<{ command: string; args: string }> = [];

    for (const update of updates) {
      this.lastUpdateId = update.update_id;

      // Only process messages from the configured chat
      if (
        update.message?.chat?.id?.toString() === this.chatId &&
        update.message.text
      ) {
        const text = update.message.text.trim();

        // Check if it's a command (starts with /)
        if (text.startsWith('/')) {
          const parts = text.split(' ');
          const command = parts[0].toLowerCase();
          const args = parts.slice(1).join(' ');

          commands.push({ command, args });
        }
      }
    }

    // Save the last update ID to database
    if (this.database && this.lastUpdateId > 0) {
      this.database.setBotState('last_update_id', this.lastUpdateId.toString());
    }

    return commands;
  }

  // Send a response message
  async sendResponse(message: string): Promise<void> {
    try {
      await this.client.post('/sendMessage', {
        chat_id: this.chatId,
        text: message,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      });
    } catch (error) {
      const message = getErrorMessage(error);
      this.logger?.error(`❌ Failed to send response: ${message}`);
    }
  }
}
