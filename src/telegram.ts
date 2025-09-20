import axios, { type AxiosInstance } from 'axios';
import type { ShowtimeDatabase } from './database.js';
import type { Logger } from './logger.js';

export interface TelegramMessage {
  movieName: string;
  theatreName: string;
  showDateTime: string;
  showDateTimeLocal: string;
  auditorium: number;
  attributes: Array<{ code: string; name: string; description?: string }>;
  ticketUrl?: string;
  isSoldOut: boolean;
  isAlmostSoldOut: boolean;
}

export class TelegramBot {
  private client: AxiosInstance;
  private lastUpdateId: number = 0;

  constructor(
    botToken: string,
    private chatId: string,
    private database?: ShowtimeDatabase,
    private logger?: Logger
  ) {
    this.client = axios.create({
      baseURL: `https://api.telegram.org/bot${botToken}`,
      timeout: 10000,
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
        this.logger?.error(
          `❌ Failed to send batch notification for ${movieName}: ${error.message}`,
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
    const sortedMessages = messages.sort(
      (a, b) =>
        new Date(a.showDateTimeLocal).getTime() -
        new Date(b.showDateTimeLocal).getTime()
    );

    const showtimeList = sortedMessages
      .map((msg) => {
        const date = new Date(msg.showDateTimeLocal);
        const dateStr = date.toLocaleDateString('en-US', {
          weekday: 'short',
          month: 'short',
          day: 'numeric',
        });
        const timeStr = date.toLocaleTimeString('en-US', {
          hour: 'numeric',
          minute: '2-digit',
          hour12: true,
        });

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

🏛️ ${messages[0].theatreName}

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

    if (otherFormats.length > 0) {
      return otherFormats[0].name.replace(/ at AMC$/, '');
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
      this.logger?.error(
        `❌ Failed to connect to Telegram bot: ${error.message}`
      );
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
      this.logger?.error(`❌ Failed to send test message: ${error.message}`);
      throw error;
    }
  }

  // Check for new messages and return commands
  async checkForCommands(): Promise<Array<{ command: string; args: string }>> {
    try {
      const response = await this.client.get('/getUpdates', {
        params: {
          offset: this.lastUpdateId + 1,
          limit: 20,
          timeout: 0, // No long polling - return immediately
          allowed_updates: ['message'], // Only message updates, not other types
        },
      });

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
        this.database.setBotState(
          'last_update_id',
          this.lastUpdateId.toString()
        );
      }

      return commands;
    } catch (error) {
      this.logger?.error(`❌ Error checking for commands: ${error.message}`);
      return [];
    }
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
      this.logger?.error(`❌ Failed to send response: ${error.message}`);
    }
  }
}
