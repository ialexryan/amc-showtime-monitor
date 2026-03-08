import { describe, expect, test } from 'bun:test';
import {
  buildAmbiguitySignature,
  createMovieResolutionContext,
  encodeWatchlistCallbackAction,
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
