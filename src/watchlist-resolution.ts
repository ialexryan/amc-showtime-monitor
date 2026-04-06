import { createHash } from 'node:crypto';
import Fuse from 'fuse.js';
import type { AMCMovie } from './amc-api.js';

const STRONG_MATCH_THRESHOLD = 0.25;
const CALLBACK_SIGNATURE_LENGTH = 12;
const CALLBACK_PREFIX = 'wl';

export interface MovieResolutionContext {
  fuse: Fuse<AMCMovie>;
  moviesById: Map<number, AMCMovie>;
  normalizedTitleMap: Map<string, AMCMovie[]>;
}

export interface WatchlistCandidate {
  movieId: number;
  movieName: string;
  movieSlug: string;
  score: number;
}

export type WatchlistResolutionResult =
  | {
      state: 'resolved';
      resolvedMovie: AMCMovie;
      candidates: WatchlistCandidate[];
    }
  | {
      state: 'ambiguous';
      candidates: WatchlistCandidate[];
    }
  | {
      state: 'unmatched';
      candidates: WatchlistCandidate[];
    };

export type WatchlistCallbackAction =
  | {
      type: 'pick';
      watchlistEntryId: number;
      movieId: number;
      ambiguitySignature: string;
    }
  | {
      type: 'keep';
      watchlistEntryId: number;
      ambiguitySignature: string;
    };

export function normalizeWatchlistQuery(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[^\p{Letter}\p{Number}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

export function createMovieResolutionContext(
  movies: AMCMovie[]
): MovieResolutionContext {
  const normalizedTitleMap = new Map<string, AMCMovie[]>();
  const moviesById = new Map<number, AMCMovie>();

  for (const movie of movies) {
    moviesById.set(movie.id, movie);
    const normalizedTitle = normalizeWatchlistQuery(movie.name);
    const existingMovies = normalizedTitleMap.get(normalizedTitle) ?? [];
    existingMovies.push(movie);
    normalizedTitleMap.set(normalizedTitle, existingMovies);
  }

  return {
    fuse: new Fuse(movies, {
      keys: ['name'],
      threshold: STRONG_MATCH_THRESHOLD,
      includeScore: true,
    }),
    moviesById,
    normalizedTitleMap,
  };
}

export function resolveWatchlistQuery(
  queryText: string,
  context: MovieResolutionContext
): WatchlistResolutionResult {
  const normalizedQuery = normalizeWatchlistQuery(queryText);
  const exactMatches = context.normalizedTitleMap.get(normalizedQuery) ?? [];

  if (exactMatches.length === 1) {
    const [resolvedMovie] = exactMatches;
    if (!resolvedMovie) {
      return { state: 'unmatched', candidates: [] };
    }

    return {
      state: 'resolved',
      resolvedMovie,
      candidates: [toCandidate(resolvedMovie, 0)],
    };
  }

  if (exactMatches.length > 1) {
    return {
      state: 'ambiguous',
      candidates: exactMatches.map((movie) => toCandidate(movie, 0)),
    };
  }

  const fuzzyMatches = context.fuse.search(queryText);
  const candidates = fuzzyMatches
    .filter((result) => (result.score ?? 1) <= STRONG_MATCH_THRESHOLD)
    .map((result) => toCandidate(result.item, result.score ?? 0));

  if (candidates.length === 1) {
    const [candidate] = candidates;
    if (!candidate) {
      return { state: 'unmatched', candidates: [] };
    }

    const resolvedMovie = context.moviesById.get(candidate.movieId);
    if (!resolvedMovie) {
      return { state: 'unmatched', candidates: [] };
    }

    return {
      state: 'resolved',
      resolvedMovie,
      candidates,
    };
  }

  if (candidates.length > 1) {
    return {
      state: 'ambiguous',
      candidates,
    };
  }

  return {
    state: 'unmatched',
    candidates: [],
  };
}

export function resolveDirectSearchMatches(
  queryText: string,
  directMatches: AMCMovie[]
): WatchlistResolutionResult {
  if (directMatches.length === 0) {
    return {
      state: 'unmatched',
      candidates: [],
    };
  }

  const normalizedQuery = normalizeWatchlistQuery(queryText);
  const exactMatches = directMatches.filter(
    (movie) => normalizeWatchlistQuery(movie.name) === normalizedQuery
  );

  if (exactMatches.length === 0) {
    return {
      state: 'unmatched',
      candidates: [],
    };
  }

  const candidates = exactMatches.map((movie) => toCandidate(movie, 0));
  const resolvedMovie = selectPreferredDirectMatch(exactMatches);

  if (!resolvedMovie) {
    return {
      state: 'unmatched',
      candidates: [],
    };
  }

  return {
    state: 'resolved',
    resolvedMovie,
    candidates,
  };
}

export function findResolvedMovieVariants(
  resolvedMovie: Pick<AMCMovie, 'id' | 'name' | 'slug'>,
  context: MovieResolutionContext
): AMCMovie[] {
  const normalizedResolvedTitle = normalizeWatchlistQuery(resolvedMovie.name);
  if (!normalizedResolvedTitle) {
    return [
      {
        id: resolvedMovie.id,
        name: resolvedMovie.name,
        slug: resolvedMovie.slug,
      },
    ];
  }

  const matchingMovies = new Map<number, AMCMovie>();
  const catalogResolvedMovie = context.moviesById.get(resolvedMovie.id);
  matchingMovies.set(
    resolvedMovie.id,
    catalogResolvedMovie ?? {
      id: resolvedMovie.id,
      name: resolvedMovie.name,
      slug: resolvedMovie.slug,
    }
  );

  for (const movie of context.moviesById.values()) {
    if (movie.id === resolvedMovie.id) {
      continue;
    }

    const normalizedMovieTitle = normalizeWatchlistQuery(movie.name);
    if (
      normalizedMovieTitle &&
      containsWholeTitleSubstring(normalizedMovieTitle, normalizedResolvedTitle)
    ) {
      matchingMovies.set(movie.id, movie);
    }
  }

  return [...matchingMovies.values()].sort((left, right) => {
    if (left.id === resolvedMovie.id) {
      return -1;
    }
    if (right.id === resolvedMovie.id) {
      return 1;
    }
    return left.name.localeCompare(right.name);
  });
}

export function buildAmbiguitySignature(
  candidates: Array<{ movieId: number }>
): string {
  return createHash('sha1')
    .update(candidates.map((candidate) => candidate.movieId).join(','))
    .digest('hex')
    .slice(0, CALLBACK_SIGNATURE_LENGTH);
}

export function encodeWatchlistCallbackAction(
  action: WatchlistCallbackAction
): string {
  if (action.type === 'pick') {
    return [
      CALLBACK_PREFIX,
      'pick',
      action.watchlistEntryId,
      action.movieId,
      action.ambiguitySignature,
    ].join(':');
  }

  return [
    CALLBACK_PREFIX,
    'keep',
    action.watchlistEntryId,
    action.ambiguitySignature,
  ].join(':');
}

export function parseWatchlistCallbackAction(
  callbackData: string
): WatchlistCallbackAction | null {
  const parts = callbackData.split(':');
  const [prefix, actionType, entryIdPart, movieIdOrSignature, maybeSignature] =
    parts;

  if (prefix !== CALLBACK_PREFIX || !entryIdPart) {
    return null;
  }

  const watchlistEntryId = Number.parseInt(entryIdPart, 10);
  if (!Number.isInteger(watchlistEntryId)) {
    return null;
  }

  if (actionType === 'pick' && movieIdOrSignature && maybeSignature) {
    const movieId = Number.parseInt(movieIdOrSignature, 10);
    if (!Number.isInteger(movieId)) {
      return null;
    }

    return {
      type: 'pick',
      watchlistEntryId,
      movieId,
      ambiguitySignature: maybeSignature,
    };
  }

  if (actionType === 'keep' && movieIdOrSignature) {
    return {
      type: 'keep',
      watchlistEntryId,
      ambiguitySignature: movieIdOrSignature,
    };
  }

  return null;
}

function toCandidate(movie: AMCMovie, score: number): WatchlistCandidate {
  return {
    movieId: movie.id,
    movieName: movie.name,
    movieSlug: movie.slug,
    score,
  };
}

function containsWholeTitleSubstring(
  candidateTitle: string,
  resolvedTitle: string
): boolean {
  return ` ${candidateTitle} `.includes(` ${resolvedTitle} `);
}

function selectPreferredDirectMatch(movies: AMCMovie[]): AMCMovie | null {
  const [preferredMovie] = [...movies].sort(comparePreferredDirectMatches);
  return preferredMovie ?? null;
}

function comparePreferredDirectMatches(
  left: AMCMovie,
  right: AMCMovie
): number {
  const scheduledDelta =
    Number(right.hasScheduledShowtimes === true) -
    Number(left.hasScheduledShowtimes === true);
  if (scheduledDelta !== 0) {
    return scheduledDelta;
  }

  const leftEarliestShowing = parseOptionalDateTime(
    left.earliestShowingUtc ?? left.releaseDateUtc
  );
  const rightEarliestShowing = parseOptionalDateTime(
    right.earliestShowingUtc ?? right.releaseDateUtc
  );

  if (leftEarliestShowing !== null && rightEarliestShowing !== null) {
    if (leftEarliestShowing !== rightEarliestShowing) {
      return leftEarliestShowing - rightEarliestShowing;
    }
  } else if (leftEarliestShowing !== null) {
    return -1;
  } else if (rightEarliestShowing !== null) {
    return 1;
  }

  return right.id - left.id;
}

function parseOptionalDateTime(value?: string): number | null {
  if (!value) {
    return null;
  }

  const parsedDate = Date.parse(value);
  return Number.isNaN(parsedDate) ? null : parsedDate;
}
