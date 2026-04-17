import { describe, expect, test } from 'bun:test';
import {
  buildAmbiguitySignature,
  createMovieResolutionContext,
  encodeWatchlistCallbackAction,
  findResolvedMovieVariants,
  generateDirectSearchVariants,
  normalizeWatchlistQuery,
  parseWatchlistCallbackAction,
  resolveDirectSearchMatches,
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
      'deadpool and wolverine'
    );
    expect(normalizeWatchlistQuery('Star Wars Episode III')).toBe(
      'star wars episode 3'
    );
    expect(normalizeWatchlistQuery('Star Wars Ep. Three')).toBe(
      'star wars episode 3'
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

  test('resolves movie titles with equivalent connector wording', () => {
    const context = createMovieResolutionContext([
      {
        id: 60322,
        name: 'Star Wars: The Mandalorian and Grogu',
        slug: 'star-wars-the-mandalorian-and-grogu-60322',
      },
    ]);
    const result = resolveWatchlistQuery(
      'Star Wars: The Mandalorian & Grogu',
      context
    );

    expect(result.state).toBe('resolved');
    if (result.state !== 'resolved') {
      throw new Error('Expected an exact normalized match');
    }

    expect(result.resolvedMovie.id).toBe(60322);
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

  test('resolves duplicate exact-title direct matches to the scheduled movie', () => {
    const result = resolveDirectSearchMatches('Dune: Part Three', [
      {
        id: 77032,
        name: 'Dune: Part Three',
        slug: 'dune-part-three-77032',
        hasScheduledShowtimes: false,
        releaseDateUtc: '2026-12-18T06:00:00Z',
      },
      {
        id: 83391,
        name: 'Dune: Part Three',
        slug: 'dune-part-three-83391',
        hasScheduledShowtimes: true,
        earliestShowingUtc: '2026-12-17T19:00:00Z',
        releaseDateUtc: '2026-12-18T06:00:00Z',
      },
    ]);

    expect(result.state).toBe('resolved');
    if (result.state !== 'resolved') {
      throw new Error('Expected direct search to resolve');
    }

    expect(result.resolvedMovie.id).toBe(83391);
    expect(result.candidates.map((candidate) => candidate.movieId)).toEqual([
      77032, 83391,
    ]);
  });

  test('resolves direct matches when titles differ only by movie-specific normalization', () => {
    const result = resolveDirectSearchMatches(
      'Star Wars: The Mandalorian & Grogu',
      [
        {
          id: 60322,
          name: 'Star Wars: The Mandalorian and Grogu',
          slug: 'star-wars-the-mandalorian-and-grogu-60322',
          hasScheduledShowtimes: true,
        },
      ]
    );

    expect(result.state).toBe('resolved');
    if (result.state !== 'resolved') {
      throw new Error('Expected direct search to resolve');
    }

    expect(result.resolvedMovie.id).toBe(60322);
  });

  test('keeps direct search unmatched when only non-exact titles are returned', () => {
    const result = resolveDirectSearchMatches('Dune: Part Three', [
      {
        id: 90001,
        name: 'Dune: Part Three Opening Night Event',
        slug: 'dune-part-three-opening-night-event',
        hasScheduledShowtimes: true,
      },
    ]);

    expect(result.state).toBe('unmatched');
  });

  test('generates direct-search variants for movie-specific title equivalence', () => {
    expect(
      generateDirectSearchVariants('Star Wars: The Mandalorian & Grogu')
    ).toEqual(
      expect.arrayContaining([
        'Star Wars: The Mandalorian & Grogu',
        'star wars: the mandalorian and grogu',
      ])
    );

    expect(generateDirectSearchVariants('Star Wars Episode III')).toEqual(
      expect.arrayContaining(['Star Wars Episode III', 'star wars episode 3'])
    );

    expect(generateDirectSearchVariants('Star Wars Episode 3')).toEqual(
      expect.arrayContaining(['Star Wars Episode 3', 'star wars episode iii'])
    );
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
