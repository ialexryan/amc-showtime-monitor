import axios, { type AxiosInstance } from 'axios';

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

  constructor(
    botToken: string,
    private chatId: string
  ) {
    this.client = axios.create({
      baseURL: `https://api.telegram.org/bot${botToken}`,
      timeout: 10000,
    });
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
          disable_web_page_preview: false,
        });

        console.log(
          `✅ Batch notification sent for ${movieName} (${movieMessages.length} showtimes)`
        );

        // Small delay between messages to avoid rate limiting
        if (movieGroups.size > 1) {
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      } catch (error) {
        console.error(
          `❌ Failed to send batch notification for ${movieName}:`,
          error.message
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

        return `${statusEmoji} ${dateStr} ${timeStr}${formatStr ? ` - ${formatStr}` : ` - Aud ${msg.auditorium}`}`;
      })
      .join('\n');

    const ticketUrl = messages[0].ticketUrl;
    const ticketLink = ticketUrl
      ? `\n\n🎫 <a href="${ticketUrl}">Buy Tickets</a>`
      : '';

    const showtimeCount =
      messages.length === 1
        ? 'New Showtime'
        : `${messages.length} New Showtimes`;

    return `🎬 <b>${showtimeCount} for ${movieName}!</b>

🏛️ ${messages[0].theatreName}

${showtimeList}${ticketLink}`;
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
        return found.name;
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
      return otherFormats[0].name;
    }

    return '';
  }

  // Test the connection and get bot info
  async testConnection(): Promise<boolean> {
    try {
      const response = await this.client.get('/getMe');
      console.log(
        `✅ Telegram bot connected: ${response.data.result.username}`
      );
      return true;
    } catch (error) {
      console.error('❌ Failed to connect to Telegram bot:', error.message);
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

      console.log('✅ Test message sent successfully');
    } catch (error) {
      console.error('❌ Failed to send test message:', error.message);
      throw error;
    }
  }
}
