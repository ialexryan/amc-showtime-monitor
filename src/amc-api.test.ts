import { afterEach, describe, expect, test } from 'bun:test';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { AMCApiClient } from './amc-api.js';
import {
  HttpStatusError,
  isRateLimitError,
  isTransientError,
} from './errors.js';

let activeServer: Server | null = null;

afterEach(async () => {
  if (activeServer) {
    const server = activeServer;
    activeServer = null;

    server.closeAllConnections?.();
    server.closeIdleConnections?.();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          if (
            error instanceof Error &&
            error.message.includes('Server is not running')
          ) {
            resolve();
            return;
          }
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
});

async function withMockAmcServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void
): Promise<string> {
  activeServer = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    activeServer?.once('error', reject);
    activeServer?.listen(0, '127.0.0.1', () => resolve());
  });

  const address = activeServer.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to start test server');
  }

  return `http://127.0.0.1:${address.port}`;
}

describe('AMCApiClient', () => {
  test('times out a slow showtime request quickly', async () => {
    const baseUrl = await withMockAmcServer((_request, response) => {
      const timer = setTimeout(() => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            pageSize: 1000,
            pageNumber: 1,
            count: 0,
            _embedded: { showtimes: [] },
          })
        );
      }, 15_000);
      timer.unref?.();
    });

    const client = new AMCApiClient('test-key', undefined, {
      baseUrl,
      requestTimeoutMs: 25,
    });

    const startedAt = Date.now();
    await expect(
      client.getShowtimesForMovieAtTheatre(71465, 2325)
    ).rejects.toThrow(/request timed out after/i);
    expect(Date.now() - startedAt).toBeLessThan(250);
  });

  test('returns an empty showtime list for HTTP 404', async () => {
    const baseUrl = await withMockAmcServer((_request, response) => {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ description: 'Not Found' }));
    });

    const client = new AMCApiClient('test-key', undefined, {
      baseUrl,
      requestTimeoutMs: 25,
    });

    await expect(
      client.getShowtimesForMovieAtTheatre(71465, 2325)
    ).resolves.toEqual([]);
  });

  test('classifies AMC rate limiting and 5xx responses correctly', async () => {
    const rateLimitedClient = new AMCApiClient('test-key', undefined, {
      fetchImpl: (async () =>
        new Response(JSON.stringify({ description: 'Too Many Requests' }), {
          status: 429,
          headers: { 'content-type': 'application/json' },
        })) as unknown as typeof fetch,
      requestTimeoutMs: 25,
    });

    await expect(rateLimitedClient.getAllMovies()).resolves.toEqual([]);
    expect(
      isRateLimitError(
        new Error('Rate limited by AMC API. Please reduce polling frequency.')
      )
    ).toBe(true);

    const serverError = new HttpStatusError(
      503,
      'AMC API request failed with HTTP 503'
    );
    expect(isTransientError(serverError)).toBe(true);
  });
});
