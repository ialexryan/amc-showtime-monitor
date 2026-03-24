import { describe, expect, test } from 'bun:test';
import {
  buildAmbiguitySignature,
  createMovieResolutionContext,
  encodeWatchlistCallbackAction,
  findResolvedMovieVariants,
  normalizeWatchlistQuery,
  parseWatchlistCallbackAction,
  resolveWatchlistQuery,
} from './watchlist-resolution.js';

const sampleMovies = [
  { id: 1, name: 'Tron: Ares', slug: 'tron-ares' },
  {
    id: 2,
    name: 'The Batman',
    slug: 'the-batman',
  },
  {
    id: 3,
    name: 'Batman Part II',
    slug: 'batman-part-2',
  },
] as const;

describe('watchlist-resolution', () => {
  test('normalizes watchlist queries for duplicate detection', () => {
    expect(normalizeWatchlistQuery('  Tron:   Ares  ')).toBe('tron ares');
    expect(normalizeWatchlistQuery('Deadpool & Wolverine')).toBe(
      'deadpool wolverine'
    );
  });

  test('resolves an exact normalized title match', () => {
    const context = createMovieResolutionContext([...sampleMovies]);
    const result = resolveWatchlistQuery('Tron Ares', context);

    expect(result.state).toBe('resolved');
    if (result.state !== 'resolved') {
      throw new Error('Expected a resolved match');
    }

    expect(result.resolvedMovie.id).toBe(1);
  });

  test('resolves a unique strong fuzzy match', () => {
    const context = createMovieResolutionContext([...sampleMovies]);
    const result = resolveWatchlistQuery('Tron: Are', context);

    expect(result.state).toBe('resolved');
    if (result.state !== 'resolved') {
      throw new Error('Expected a resolved fuzzy match');
    }

    expect(result.resolvedMovie.id).toBe(1);
  });

  test('marks multiple strong matches as ambiguous', () => {
    const context = createMovieResolutionContext([...sampleMovies]);
    const result = resolveWatchlistQuery('Batman', context);

    expect(result.state).toBe('ambiguous');
    if (result.state !== 'ambiguous') {
      throw new Error('Expected an ambiguous result');
    }

    expect(result.candidates.length).toBeGreaterThan(1);
  });

  test('marks unknown movies as unmatched', () => {
    const context = createMovieResolutionContext([...sampleMovies]);
    const result = resolveWatchlistQuery('The Odyssey', context);

    expect(result.state).toBe('unmatched');
  });

  test('finds resolved-title variants when the full title appears as a whole substring', () => {
    const context = createMovieResolutionContext([
      {
        id: 10,
        name: 'The Devil Wears Prada 2',
        slug: 'the-devil-wears-prada-2',
      },
      {
        id: 11,
        name: 'The Devil Wears Prada 2 Opening Night Event',
        slug: 'the-devil-wears-prada-2-opening-night-event',
      },
      {
        id: 15,
        name: 'The Devil Wears Prada 2: Opening Night Event',
        slug: 'the-devil-wears-prada-2-opening-night-event-colon',
      },
      {
        id: 12,
        name: 'Fan Event: The Devil Wears Prada 2',
        slug: 'fan-event-the-devil-wears-prada-2',
      },
      {
        id: 13,
        name: 'Fan Event: The Devil Wears Prada 2 Opening Night Event',
        slug: 'fan-event-the-devil-wears-prada-2-opening-night-event',
      },
      {
        id: 14,
        name: 'The Devil Wears Prada 20',
        slug: 'the-devil-wears-prada-20',
      },
    ]);

    const variants = findResolvedMovieVariants(
      {
        id: 10,
        name: 'The Devil Wears Prada 2',
        slug: 'the-devil-wears-prada-2',
      },
      context
    );

    expect(variants.map((movie) => movie.id)).toEqual([10, 12, 13, 11, 15]);
  });

  test('keeps the resolved movie even when it is absent from the current catalog', () => {
    const context = createMovieResolutionContext([
      {
        id: 11,
        name: 'The Devil Wears Prada 2 Opening Night Event',
        slug: 'the-devil-wears-prada-2-opening-night-event',
      },
    ]);

    const variants = findResolvedMovieVariants(
      {
        id: 10,
        name: 'The Devil Wears Prada 2',
        slug: 'the-devil-wears-prada-2',
      },
      context
    );

    expect(variants.map((movie) => movie.id)).toEqual([10, 11]);
    expect(variants[0]?.slug).toBe('the-devil-wears-prada-2');
  });

  test('encodes and parses callback payloads', () => {
    const signature = buildAmbiguitySignature([{ movieId: 2 }, { movieId: 3 }]);
    const encodedPick = encodeWatchlistCallbackAction({
      type: 'pick',
      watchlistEntryId: 42,
      movieId: 3,
      ambiguitySignature: signature,
    });
    const encodedKeep = encodeWatchlistCallbackAction({
      type: 'keep',
      watchlistEntryId: 42,
      ambiguitySignature: signature,
    });

    expect(parseWatchlistCallbackAction(encodedPick)).toEqual({
      type: 'pick',
      watchlistEntryId: 42,
      movieId: 3,
      ambiguitySignature: signature,
    });
    expect(parseWatchlistCallbackAction(encodedKeep)).toEqual({
      type: 'keep',
      watchlistEntryId: 42,
      ambiguitySignature: signature,
    });
  });
});
