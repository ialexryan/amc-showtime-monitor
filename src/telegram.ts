import type { ShowtimeDatabase } from './database.js';
import {
  getErrorMessage,
  HttpStatusError,
  RequestTimeoutError,
} from './errors.js';
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

export type TelegramUpdate =
  | {
      type: 'command';
      command: string;
      args: string;
    }
  | {
      type: 'callback';
      callbackQueryId: string;
      callbackData: string;
      messageId?: number;
    };

export interface TelegramInlineButton {
  text: string;
  callbackData: string;
}

interface TelegramBotOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

interface TelegramApiEnvelope<T> {
  ok: boolean;
  result?: T;
  description?: string;
}

interface ShowtimeDisplayGroup {
  dayLabel: string;
  formatLabel: string;
  formatSortRank: number;
  formatSortLabel: string;
  entries: string[];
}

const TELEGRAM_MESSAGE_CHAR_LIMIT = 4096;
const TELEGRAM_MESSAGE_SAFE_LIMIT = 3800;
const TELEGRAM_FORMAT_LINE_SAFE_LIMIT = 1200;
const PREMIUM_FORMAT_CODES = [
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

export class TelegramBot {
  private lastUpdateId: number = 0;
  private readonly defaultTimeoutMs = 10_000;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(
    botToken: string,
    private chatId: string,
    private database?: ShowtimeDatabase,
    private logger?: Logger,
    options: TelegramBotOptions = {}
  ) {
    this.baseUrl = options.baseUrl ?? `https://api.telegram.org/bot${botToken}`;
    this.fetchImpl = options.fetchImpl ?? fetch;

    if (this.database) {
      const lastId = this.database.getBotState('last_update_id');
      this.lastUpdateId = lastId ? parseInt(lastId, 10) : 0;
    }
  }

  async sendBatchNotification(messages: TelegramMessage[]): Promise<void> {
    if (messages.length === 0) return;

    const movieGroups = this.groupMessagesByMovie(messages);

    for (const [movieName, movieMessages] of movieGroups) {
      await this.sendMovieNotification(movieName, movieMessages);

      if (movieGroups.size > 1) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
  }

  async sendMovieNotification(
    movieName: string,
    messages: TelegramMessage[]
  ): Promise<void> {
    const batchMessages = this.formatBatchMessages(movieName, messages);
    if (batchMessages.length === 0) {
      return;
    }

    try {
      for (const batchMessage of batchMessages) {
        await this.callTelegramApi('/sendMessage', {
          method: 'POST',
          body: {
            chat_id: this.chatId,
            text: batchMessage,
            parse_mode: 'HTML',
            disable_web_page_preview: true,
          },
        });
      }

      this.logger?.info(
        `✅ Batch notification sent for ${movieName} (${messages.length} showtimes)`,
        { movie: movieName }
      );
    } catch (error) {
      const message = getErrorMessage(error);
      this.logger?.error(
        `❌ Failed to send batch notification for ${movieName}: ${message}`,
        { movie: movieName }
      );
      throw error;
    }
  }

  private groupMessagesByMovie(
    messages: TelegramMessage[]
  ): Map<string, TelegramMessage[]> {
    const movieGroups = new Map<string, TelegramMessage[]>();
    messages.forEach((msg) => {
      const key = msg.movieName;
      if (!movieGroups.has(key)) {
        movieGroups.set(key, []);
      }
      movieGroups.get(key)?.push(msg);
    });
    return movieGroups;
  }

  private formatBatchMessages(
    movieName: string,
    messages: TelegramMessage[]
  ): string[] {
    const [firstMessage] = messages;
    if (!firstMessage) {
      return [];
    }

    const sortedMessages = [...messages].sort(
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
    const showtimeLines = this.buildShowtimeLines(sortedMessages);

    const showtimeCount =
      messages.length === 1
        ? 'New Showtime'
        : `${messages.length} New Showtimes`;

    const buildHeader = (partIndex: number, partCount: number): string => {
      const partSuffix =
        partCount > 1 ? ` <i>(${partIndex + 1}/${partCount})</i>` : '';
      return `🎬 <b>${this.escapeHtml(showtimeCount)} for ${this.escapeHtml(movieName)}!${partSuffix}</b>

🏛️ ${this.escapeHtml(firstMessage.theatreName)}

`;
    };

    const chunks: string[] = [];
    let currentChunkLines: string[] = [];

    const flushChunk = (): void => {
      if (currentChunkLines.length === 0) {
        return;
      }
      chunks.push(currentChunkLines.join('\n'));
      currentChunkLines = [];
    };

    for (const line of showtimeLines) {
      const tentativeLines = [...currentChunkLines, line];
      const tentativeText = buildHeader(0, 1) + tentativeLines.join('\n');
      if (
        tentativeText.length > TELEGRAM_MESSAGE_SAFE_LIMIT &&
        currentChunkLines.length > 0
      ) {
        flushChunk();
      }
      currentChunkLines.push(line);
    }

    flushChunk();

    return chunks.map((chunk, index) => {
      const message = buildHeader(index, chunks.length) + chunk;
      if (message.length <= TELEGRAM_MESSAGE_CHAR_LIMIT) {
        return message;
      }
      return message.slice(0, TELEGRAM_MESSAGE_CHAR_LIMIT);
    });
  }

  private buildShowtimeLines(messages: TelegramMessage[]): string[] {
    const dayGroups = new Map<string, Map<string, ShowtimeDisplayGroup>>();

    for (const message of messages) {
      const dayLabel = formatShowtimeDate(
        message.showDateTimeUtc,
        message.showDateTimeLocal,
        message.utcOffset
      );
      const timeLabel = formatShowtimeTime(
        message.showDateTimeUtc,
        message.showDateTimeLocal,
        message.utcOffset
      );
      const formatGroup = this.getFormatGroup(message);
      const dayGroup = dayGroups.get(dayLabel) ?? new Map();
      if (!dayGroups.has(dayLabel)) {
        dayGroups.set(dayLabel, dayGroup);
      }

      const existingGroup = dayGroup.get(formatGroup.label);
      if (existingGroup) {
        existingGroup.entries.push(
          this.formatShowtimeToken(message, timeLabel)
        );
        continue;
      }

      dayGroup.set(formatGroup.label, {
        dayLabel,
        formatLabel: formatGroup.label,
        formatSortRank: formatGroup.sortRank,
        formatSortLabel: formatGroup.sortLabel,
        entries: [this.formatShowtimeToken(message, timeLabel)],
      });
    }

    const lines: string[] = [];
    for (const [dayLabel, formatGroups] of dayGroups.entries()) {
      if (lines.length > 0) {
        lines.push('');
      }

      lines.push(`<b>${this.escapeHtml(dayLabel)}</b>`);
      const sortedFormats = Array.from(formatGroups.values()).sort((a, b) => {
        if (a.formatSortRank !== b.formatSortRank) {
          return a.formatSortRank - b.formatSortRank;
        }

        return a.formatSortLabel.localeCompare(b.formatSortLabel, undefined, {
          numeric: true,
          sensitivity: 'base',
        });
      });

      for (const formatGroup of sortedFormats) {
        lines.push(
          ...this.buildFormatLines(formatGroup.formatLabel, formatGroup.entries)
        );
      }
    }

    return lines;
  }

  private buildFormatLines(formatLabel: string, entries: string[]): string[] {
    const prefix = `${this.escapeHtml(formatLabel)}: `;
    const lines: string[] = [];
    let currentEntries: string[] = [];

    for (const entry of entries) {
      const tentativeEntries = [...currentEntries, entry];
      const tentativeLine = `${prefix}${tentativeEntries.join(', ')}`;
      if (
        tentativeLine.length > TELEGRAM_FORMAT_LINE_SAFE_LIMIT &&
        currentEntries.length > 0
      ) {
        lines.push(`${prefix}${currentEntries.join(', ')}`);
        currentEntries = [entry];
        continue;
      }

      currentEntries.push(entry);
    }

    if (currentEntries.length > 0) {
      lines.push(`${prefix}${currentEntries.join(', ')}`);
    }

    return lines;
  }

  private formatShowtimeToken(
    message: TelegramMessage,
    timeLabel: string
  ): string {
    const escapedTime = this.escapeHtml(timeLabel);
    const linkedTime = message.ticketUrl
      ? `<a href="${this.escapeHtmlAttribute(message.ticketUrl)}">${escapedTime}</a>`
      : escapedTime;

    if (message.isSoldOut) {
      return `❌ ${linkedTime}`;
    }

    if (message.isAlmostSoldOut) {
      return `⚠️ ${linkedTime}`;
    }

    return linkedTime;
  }

  private getFormatGroup(
    message: Pick<TelegramMessage, 'attributes' | 'auditorium'>
  ): { label: string; sortRank: number; sortLabel: string } {
    const formatLabel = this.getFormatString(message.attributes);
    if (formatLabel) {
      const matchedPremiumIndex = this.getPremiumFormatIndex(
        message.attributes
      );
      const sortRank =
        matchedPremiumIndex >= 0
          ? matchedPremiumIndex
          : PREMIUM_FORMAT_CODES.length;
      return {
        label: formatLabel,
        sortRank,
        sortLabel: formatLabel,
      };
    }

    const fallbackLabel = `Aud ${message.auditorium}`;
    return {
      label: fallbackLabel,
      sortRank: PREMIUM_FORMAT_CODES.length + 1,
      sortLabel: fallbackLabel,
    };
  }

  private getPremiumFormatIndex(
    attributes: Array<{ code: string; name: string }>
  ): number {
    for (const [index, format] of PREMIUM_FORMAT_CODES.entries()) {
      const found = attributes.find(
        (attr) => attr.code.toUpperCase() === format
      );
      if (found) {
        return index;
      }
    }

    return -1;
  }

  private getFormatString(
    attributes: Array<{ code: string; name: string }>
  ): string {
    const premiumFormatIndex = this.getPremiumFormatIndex(attributes);
    if (premiumFormatIndex >= 0) {
      const premiumCode = PREMIUM_FORMAT_CODES[premiumFormatIndex];
      const found = attributes.find(
        (attr) => attr.code.toUpperCase() === premiumCode
      );
      if (found) {
        return found.name.replace(/ at AMC$/, '');
      }
    }

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

  private escapeHtml(value: string): string {
    return value
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  private escapeHtmlAttribute(value: string): string {
    return this.escapeHtml(value);
  }

  async testConnection(): Promise<boolean> {
    try {
      const response = await this.callTelegramApi<{ username: string }>(
        '/getMe'
      );
      this.logger?.info(`✅ Telegram bot connected: ${response.username}`);
      return true;
    } catch (error) {
      const message = getErrorMessage(error);
      this.logger?.error(`❌ Failed to connect to Telegram bot: ${message}`);
      return false;
    }
  }

  async sendTestMessage(): Promise<void> {
    const testMessage = `🤖 <b>AMC Showtime Monitor Test</b>

This is a test message to verify your Telegram bot is working correctly.

Time: ${new Date().toLocaleString()}`;

    try {
      await this.callTelegramApi('/sendMessage', {
        method: 'POST',
        body: {
          chat_id: this.chatId,
          text: testMessage,
          parse_mode: 'HTML',
        },
      });

      this.logger?.info('✅ Test message sent successfully');
    } catch (error) {
      const message = getErrorMessage(error);
      this.logger?.error(`❌ Failed to send test message: ${message}`);
      throw error;
    }
  }

  async getUpdates(
    options: TelegramCommandPollOptions = {}
  ): Promise<TelegramUpdate[]> {
    const longPollTimeoutSeconds = options.timeoutSeconds ?? 0;
    const requestTimeoutMs = Math.max(
      this.defaultTimeoutMs,
      (longPollTimeoutSeconds + 10) * 1000
    );

    const updateRequestOptions: {
      params: Record<string, string | number | boolean | string[]>;
      timeoutMs: number;
      signal?: AbortSignal;
    } = {
      params: {
        offset: this.lastUpdateId + 1,
        limit: 20,
        timeout: longPollTimeoutSeconds,
        allowed_updates: ['message', 'callback_query'],
      },
      timeoutMs: requestTimeoutMs,
    };
    if (options.signal) {
      updateRequestOptions.signal = options.signal;
    }

    const updates = await this.callTelegramApi<Record<string, unknown>[]>(
      '/getUpdates',
      updateRequestOptions
    );
    const parsedUpdates: TelegramUpdate[] = [];

    for (const update of updates) {
      const updateId =
        typeof update.update_id === 'number' ? update.update_id : undefined;
      if (updateId === undefined) {
        continue;
      }

      this.lastUpdateId = updateId;
      const message = this.asRecord(update.message);
      const callbackQuery = this.asRecord(update.callback_query);
      const messageChat = this.asRecord(message?.chat);
      const callbackMessage = this.asRecord(callbackQuery?.message);
      const callbackChat = this.asRecord(callbackMessage?.chat);

      if (
        messageChat?.id?.toString() === this.chatId &&
        typeof message?.text === 'string'
      ) {
        const text = message.text.trim();
        if (text.startsWith('/')) {
          const parts = text.split(' ');
          const command = (parts[0] ?? '').toLowerCase();
          const args = parts.slice(1).join(' ');

          parsedUpdates.push({ type: 'command', command, args });
        }
      }

      if (
        callbackChat?.id?.toString() === this.chatId &&
        typeof callbackQuery?.data === 'string' &&
        typeof callbackQuery.id === 'string'
      ) {
        parsedUpdates.push({
          type: 'callback',
          callbackQueryId: callbackQuery.id,
          callbackData: callbackQuery.data,
          ...(typeof callbackMessage?.message_id === 'number'
            ? { messageId: callbackMessage.message_id }
            : {}),
        });
      }
    }

    if (this.database && this.lastUpdateId > 0) {
      this.database.setBotState('last_update_id', this.lastUpdateId.toString());
    }

    return parsedUpdates;
  }

  async checkForCommands(
    options: TelegramCommandPollOptions = {}
  ): Promise<Array<{ command: string; args: string }>> {
    const updates = await this.getUpdates(options);
    return updates.flatMap((update) =>
      update.type === 'command'
        ? [{ command: update.command, args: update.args }]
        : []
    );
  }

  async sendOrEditInlinePrompt(
    message: string,
    buttons: TelegramInlineButton[],
    existingMessageId?: number
  ): Promise<number> {
    if (existingMessageId !== undefined) {
      const edited = await this.editInlinePrompt(
        existingMessageId,
        message,
        buttons
      );
      if (edited) {
        return existingMessageId;
      }
    }

    const response = await this.callTelegramApi<{ message_id: number }>(
      '/sendMessage',
      {
        method: 'POST',
        body: {
          chat_id: this.chatId,
          text: message,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
          reply_markup: buildInlineKeyboard(buttons),
        },
      }
    );

    return response.message_id;
  }

  async answerCallbackQuery(
    callbackQueryId: string,
    message: string
  ): Promise<void> {
    try {
      await this.callTelegramApi('/answerCallbackQuery', {
        method: 'POST',
        body: {
          callback_query_id: callbackQueryId,
          text: message,
          show_alert: false,
        },
      });
    } catch (error) {
      const responseMessage = getErrorMessage(error);
      this.logger?.error(
        `❌ Failed to answer callback query: ${responseMessage}`
      );
    }
  }

  private async editInlinePrompt(
    messageId: number,
    message: string,
    buttons: TelegramInlineButton[]
  ): Promise<boolean> {
    try {
      await this.callTelegramApi('/editMessageText', {
        method: 'POST',
        body: {
          chat_id: this.chatId,
          message_id: messageId,
          text: message,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
          reply_markup: buildInlineKeyboard(buttons),
        },
      });
      return true;
    } catch (error) {
      const responseMessage = getErrorMessage(error);
      this.logger?.warn(`⚠️ Failed to edit inline prompt: ${responseMessage}`);
      return false;
    }
  }

  async sendResponse(message: string): Promise<boolean> {
    try {
      await this.callTelegramApi('/sendMessage', {
        method: 'POST',
        body: {
          chat_id: this.chatId,
          text: message,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        },
      });
      return true;
    } catch (error) {
      const responseMessage = getErrorMessage(error);
      this.logger?.error(`❌ Failed to send response: ${responseMessage}`);
      return false;
    }
  }

  private async callTelegramApi<T = unknown>(
    path: string,
    options: {
      method?: 'GET' | 'POST';
      params?: Record<string, string | number | boolean | string[]>;
      body?: unknown;
      timeoutMs?: number;
      signal?: AbortSignal;
    } = {}
  ): Promise<T> {
    const method = options.method ?? 'GET';
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    const { requestSignal, timeoutSignal } = this.createRequestSignals(
      options.signal,
      timeoutMs
    );
    const url = new URL(
      path.startsWith('/') ? path.slice(1) : path,
      this.baseUrl.endsWith('/') ? this.baseUrl : `${this.baseUrl}/`
    );

    if (options.params) {
      for (const [key, value] of Object.entries(options.params)) {
        if (Array.isArray(value)) {
          url.searchParams.set(key, JSON.stringify(value));
          continue;
        }

        url.searchParams.set(key, String(value));
      }
    }

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers:
          method === 'POST'
            ? {
                'content-type': 'application/json',
              }
            : undefined,
        body:
          method === 'POST' ? JSON.stringify(options.body ?? {}) : undefined,
        signal: requestSignal,
      });
    } catch (error) {
      if (timeoutSignal.aborted && !options.signal?.aborted) {
        throw new RequestTimeoutError(timeoutMs);
      }
      throw error;
    }

    const payload = await this.parseTelegramEnvelope<T>(response);

    if (!response.ok) {
      throw new HttpStatusError(
        response.status,
        payload.description ??
          `Telegram API request failed with HTTP ${response.status}`
      );
    }

    if (!payload.ok) {
      throw new Error(
        payload.description ??
          'Telegram API request failed without a description'
      );
    }

    if (payload.result === undefined) {
      throw new Error('Telegram API response did not include a result payload');
    }

    return payload.result;
  }

  private async parseTelegramEnvelope<T>(
    response: Response
  ): Promise<TelegramApiEnvelope<T>> {
    try {
      return (await response.json()) as TelegramApiEnvelope<T>;
    } catch (error) {
      throw new Error(
        `Failed to parse Telegram API response: ${getErrorMessage(error)}`
      );
    }
  }

  private createRequestSignals(
    signal: AbortSignal | undefined,
    timeoutMs: number
  ): {
    requestSignal: AbortSignal;
    timeoutSignal: AbortSignal;
  } {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    return {
      requestSignal: signal
        ? AbortSignal.any([signal, timeoutSignal])
        : timeoutSignal,
      timeoutSignal,
    };
  }

  private asRecord(value: unknown): Record<string, unknown> | undefined {
    return typeof value === 'object' && value !== null
      ? (value as Record<string, unknown>)
      : undefined;
  }
}

function buildInlineKeyboard(buttons: TelegramInlineButton[]) {
  return {
    inline_keyboard: buttons.map((button) => [
      {
        text: button.text,
        callback_data: button.callbackData,
      },
    ]),
  };
}
