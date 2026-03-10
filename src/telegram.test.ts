import { describe, expect, test } from 'bun:test';
import { TelegramBot, type TelegramMessage } from './telegram.js';

describe('TelegramBot notification chunking', () => {
  test('splits large movie notifications into multiple messages', async () => {
    const sentMessages: string[] = [];
    const bot = new TelegramBot('test-token', '123');
    (
      bot as unknown as {
        client: {
          post: (path: string, payload: { text: string }) => Promise<void>;
        };
      }
    ).client = {
      post: async (_path: string, payload: { text: string }) => {
        sentMessages.push(payload.text);
      },
    };

    const messages: TelegramMessage[] = Array.from(
      { length: 120 },
      (_, index) => ({
        movieName: 'The Super Mario Galaxy Movie',
        theatreName: 'AMC Metreon 16',
        showDateTimeUtc: `2026-04-01T${String(7 + Math.floor(index / 2)).padStart(2, '0')}:00:00Z`,
        showDateTimeLocal: `2026-04-01T${String(index % 24).padStart(2, '0')}:00:00`,
        utcOffset: '-07:00',
        auditorium: 1,
        attributes: [],
        ticketUrl: `https://example.com/${index}`,
        isSoldOut: false,
        isAlmostSoldOut: false,
      })
    );

    await bot.sendMovieNotification('The Super Mario Galaxy Movie', messages);

    expect(sentMessages.length).toBeGreaterThan(1);
    for (const message of sentMessages) {
      expect(message.length).toBeLessThanOrEqual(4096);
    }
  });
});
