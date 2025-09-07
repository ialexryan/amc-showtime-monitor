import axios, { type AxiosInstance } from 'axios';

export interface TelegramMessage {
  movieName: string;
  theatreName: string;
  showDateTime: string;
  showDateTimeLocal: string;
  auditorium: number;
  attributes: string[];
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

  async sendShowtimeNotification(message: TelegramMessage): Promise<void> {
    const formattedMessage = this.formatShowtimeMessage(message);

    try {
      await this.client.post('/sendMessage', {
        chat_id: this.chatId,
        text: formattedMessage,
        parse_mode: 'HTML',
        disable_web_page_preview: false,
      });

      console.log(`✅ Telegram notification sent for ${message.movieName}`);
    } catch (error) {
      console.error('❌ Failed to send Telegram notification:', error.message);
      throw error;
    }
  }

  async sendBatchNotification(messages: TelegramMessage[]): Promise<void> {
    if (messages.length === 0) return;

    if (messages.length === 1) {
      await this.sendShowtimeNotification(messages[0]);
      return;
    }

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

  private formatShowtimeMessage(message: TelegramMessage): string {
    const date = new Date(message.showDateTimeLocal);
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

    // Parse attributes to highlight premium formats
    const attributes = this.parseAttributes(message.attributes);
    const formatStr = this.getFormatString(attributes);

    // Status indicators
    let statusEmoji = '🎬';
    if (message.isSoldOut) statusEmoji = '❌';
    else if (message.isAlmostSoldOut) statusEmoji = '⚠️';

    let statusText = '';
    if (message.isSoldOut) statusText = ' <b>(SOLD OUT)</b>';
    else if (message.isAlmostSoldOut) statusText = ' <b>(Almost Sold Out)</b>';

    const ticketLink = message.ticketUrl
      ? `\n\n🎫 <a href="${message.ticketUrl}">Buy Tickets</a>`
      : '';

    return `${statusEmoji} <b>New Showtime Available!</b>

🎭 <b>${message.movieName}</b>
🏛️ ${message.theatreName}
📅 ${dateStr} at ${timeStr}
🎪 Auditorium ${message.auditorium}
${formatStr ? `🎯 ${formatStr}\n` : ''}${statusText}${ticketLink}`;
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

        const attributes = this.parseAttributes(msg.attributes);
        const formatStr = this.getFormatString(attributes);

        let statusEmoji = '🎬';
        if (msg.isSoldOut) statusEmoji = '❌';
        else if (msg.isAlmostSoldOut) statusEmoji = '⚠️';

        return `${statusEmoji} ${dateStr} ${timeStr} - Aud ${msg.auditorium}${formatStr ? ` (${formatStr})` : ''}`;
      })
      .join('\n');

    const ticketUrl = messages[0].ticketUrl;
    const ticketLink = ticketUrl
      ? `\n\n🎫 <a href="${ticketUrl}">Buy Tickets</a>`
      : '';

    return `🎬 <b>${messages.length} New Showtimes for ${movieName}!</b>

🏛️ ${messages[0].theatreName}

${showtimeList}${ticketLink}`;
  }

  private parseAttributes(
    attributesJson: string
  ): Array<{ code: string; name: string }> {
    try {
      return JSON.parse(attributesJson) || [];
    } catch {
      return [];
    }
  }

  private getFormatString(
    attributes: Array<{ code: string; name: string }>
  ): string {
    // Priority order for premium formats
    const premiumFormats = [
      'imaxwithlaseratamc',
      'imax',
      'dolbycinemaatamc',
      'dolbyatmos',
      'laseratamc',
      'reald3d',
      'dbox',
    ];

    for (const format of premiumFormats) {
      const found = attributes.find((attr) =>
        attr.code.toLowerCase().includes(format.toLowerCase())
      );
      if (found) {
        return found.name;
      }
    }

    // Look for other notable attributes
    const otherFormats = attributes.filter(
      (attr) =>
        attr.code.includes('premium') ||
        attr.code.includes('luxury') ||
        attr.code.includes('reserved')
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
