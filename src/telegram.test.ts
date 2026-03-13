import { describe, expect, test } from 'bun:test';
import { TelegramBot, type TelegramMessage } from './telegram.js';

function createTelegramFetchStub(sentMessages: string[]): typeof fetch {
  return (async (_input, init) => {
    const bodyText =
      typeof init?.body === 'string'
        ? init.body
        : init?.body instanceof Uint8Array
          ? new TextDecoder().decode(init.body)
          : '{}';
    const payload = JSON.parse(bodyText) as { text: string };
    sentMessages.push(payload.text);
    return new Response(
      JSON.stringify({
        ok: true,
        result: { message_id: sentMessages.length },
      }),
      {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }
    );
  }) as typeof fetch;
}

describe('TelegramBot notification chunking', () => {
  test('preserves Telegram error descriptions on non-2xx responses', async () => {
    const bot = new TelegramBot('test-token', '123', undefined, undefined, {
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            ok: false,
            description: 'Bad Request: message is too long',
          }),
          {
            status: 400,
            headers: { 'content-type': 'application/json' },
          }
        )) as unknown as typeof fetch,
    });

    await expect(
      bot.sendMovieNotification('The Super Mario Galaxy Movie', [
        {
          movieName: 'The Super Mario Galaxy Movie',
          theatreName: 'AMC Metreon 16',
          showDateTimeUtc: '2026-04-01T14:00:00Z',
          showDateTimeLocal: '2026-04-01T07:00:00',
          utcOffset: '-07:00',
          auditorium: 1,
          attributes: [],
          ticketUrl: 'https://example.com/imax-1',
          isSoldOut: false,
          isAlmostSoldOut: false,
        },
      ])
    ).rejects.toThrow(/message is too long/i);
  });

  test('groups showtimes by day and premium format with only the times linked', async () => {
    const sentMessages: string[] = [];
    const bot = new TelegramBot('test-token', '123', undefined, undefined, {
      fetchImpl: createTelegramFetchStub(sentMessages),
    });

    const messages: TelegramMessage[] = [
      {
        movieName: 'The Super Mario Galaxy Movie',
        theatreName: 'AMC Metreon 16',
        showDateTimeUtc: '2026-04-02T16:30:00Z',
        showDateTimeLocal: '2026-04-02T09:30:00',
        utcOffset: '-07:00',
        auditorium: 1,
        attributes: [{ code: 'LASERATAMC', name: 'Laser at AMC' }],
        ticketUrl: 'https://example.com/laser-1',
        isSoldOut: false,
        isAlmostSoldOut: false,
      },
      {
        movieName: 'The Super Mario Galaxy Movie',
        theatreName: 'AMC Metreon 16',
        showDateTimeUtc: '2026-04-01T19:00:00Z',
        showDateTimeLocal: '2026-04-01T12:00:00',
        utcOffset: '-07:00',
        auditorium: 1,
        attributes: [{ code: 'DOLBYCINEMAATAMC', name: 'Dolby Cinema at AMC' }],
        ticketUrl: 'https://example.com/dolby-1',
        isSoldOut: false,
        isAlmostSoldOut: false,
      },
      {
        movieName: 'The Super Mario Galaxy Movie',
        theatreName: 'AMC Metreon 16',
        showDateTimeUtc: '2026-04-01T14:00:00Z',
        showDateTimeLocal: '2026-04-01T07:00:00',
        utcOffset: '-07:00',
        auditorium: 1,
        attributes: [
          { code: 'IMAXWITHLASERATAMC', name: 'IMAX with Laser at AMC' },
        ],
        ticketUrl: 'https://example.com/imax-1',
        isSoldOut: false,
        isAlmostSoldOut: false,
      },
      {
        movieName: 'The Super Mario Galaxy Movie',
        theatreName: 'AMC Metreon 16',
        showDateTimeUtc: '2026-04-01T17:15:00Z',
        showDateTimeLocal: '2026-04-01T10:15:00',
        utcOffset: '-07:00',
        auditorium: 1,
        attributes: [{ code: 'LASERATAMC', name: 'Laser at AMC' }],
        ticketUrl: 'https://example.com/laser-2',
        isSoldOut: false,
        isAlmostSoldOut: false,
      },
      {
        movieName: 'The Super Mario Galaxy Movie',
        theatreName: 'AMC Metreon 16',
        showDateTimeUtc: '2026-04-02T18:30:00Z',
        showDateTimeLocal: '2026-04-02T11:30:00',
        utcOffset: '-07:00',
        auditorium: 1,
        attributes: [
          { code: 'IMAXWITHLASERATAMC', name: 'IMAX with Laser at AMC' },
        ],
        ticketUrl: 'https://example.com/imax-2',
        isSoldOut: true,
        isAlmostSoldOut: false,
      },
    ];

    await bot.sendMovieNotification('The Super Mario Galaxy Movie', messages);

    expect(sentMessages).toHaveLength(1);
    const message = sentMessages[0];
    expect(message).toBeDefined();

    if (!message) {
      throw new Error('Expected a Telegram message to be sent');
    }

    expect(message).toContain('<b>Wed, Apr 1</b>');
    expect(message).toContain('<b>Thu, Apr 2</b>');
    expect(message).toContain(
      'IMAX with Laser: <a href="https://example.com/imax-1">7:00 AM</a>'
    );
    expect(message).toContain(
      'Dolby Cinema: <a href="https://example.com/dolby-1">12:00 PM</a>'
    );
    expect(message).toContain(
      'Laser: <a href="https://example.com/laser-2">10:15 AM</a>'
    );
    expect(message).toContain(
      'IMAX with Laser: ❌ <a href="https://example.com/imax-2">11:30 AM</a>'
    );
    expect(message).not.toContain('Wed, Apr 1 7:00 AM - IMAX with Laser');

    const wedSection = message.split('<b>Thu, Apr 2</b>')[0];
    expect(wedSection).toBeDefined();

    if (!wedSection) {
      throw new Error('Expected the Wednesday section to be present');
    }

    const wedLines = wedSection
      .split('\n')
      .filter(
        (line) =>
          line.startsWith('IMAX with Laser:') ||
          line.startsWith('Dolby Cinema:') ||
          line.startsWith('Laser:')
      );

    expect(wedLines[0]).toStartWith('IMAX with Laser:');
    expect(wedLines[1]).toStartWith('Dolby Cinema:');
    expect(wedLines[2]).toStartWith('Laser:');
  });

  test('splits large movie notifications into multiple messages', async () => {
    const sentMessages: string[] = [];
    const bot = new TelegramBot('test-token', '123', undefined, undefined, {
      fetchImpl: createTelegramFetchStub(sentMessages),
    });

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
