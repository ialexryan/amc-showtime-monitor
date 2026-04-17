import { createHash } from 'node:crypto';
import Fuse from 'fuse.js';
import type { AMCMovie } from './amc-api.js';

const STRONG_MATCH_THRESHOLD = 0.25;
const CALLBACK_SIGNATURE_LENGTH = 12;
const CALLBACK_PREFIX = 'wl';
const TITLE_EQUIVALENT_REPLACEMENTS: [RegExp, string][] = [
  [/&/gu, ' and '],
  [/\bvs\.?\b/giu, ' versus '],
  [/\bep\.?\b/giu, ' episode '],
  [/\bpt\.?\b/giu, ' part '],
  [/\bch\.?\b/giu, ' chapter '],
  [/\bvol\.?\b/giu, ' volume '],
];
const SEQUEL_MARKERS = ['episode', 'part', 'chapter', 'volume'] as const;
const SEQUEL_MARKER_PATTERN = SEQUEL_MARKERS.join('|');
const NUMBER_WORD_VALUES = new Map<string, number>([
  ['one', 1],
  ['first', 1],
  ['two', 2],
  ['second', 2],
  ['three', 3],
  ['third', 3],
  ['four', 4],
  ['fourth', 4],
  ['five', 5],
  ['fifth', 5],
  ['six', 6],
  ['sixth', 6],
  ['seven', 7],
  ['seventh', 7],
  ['eight', 8],
  ['eighth', 8],
  ['nine', 9],
  ['ninth', 9],
  ['ten', 10],
  ['tenth', 10],
  ['eleven', 11],
  ['eleventh', 11],
  ['twelve', 12],
  ['twelfth', 12],
  ['thirteen', 13],
  ['thirteenth', 13],
  ['fourteen', 14],
  ['fourteenth', 14],
  ['fifteen', 15],
  ['fifteenth', 15],
  ['sixteen', 16],
  ['sixteenth', 16],
  ['seventeen', 17],
  ['seventeenth', 17],
  ['eighteen', 18],
  ['eighteenth', 18],
  ['nineteen', 19],
  ['nineteenth', 19],
  ['twenty', 20],
  ['twentieth', 20],
]);
const NUMBER_WORD_PATTERN = [...NUMBER_WORD_VALUES.keys()]
  .sort((left, right) => right.length - left.length)
  .join('|');
const ROMAN_NUMERAL_PATTERN = '[ivxlcdm]+';

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
  return normalizeTitleWhitespace(
    normalizeSequelMarkersAndNumbers(
      stripTitlePunctuation(
        replaceTitleEquivalents(normalizeTitleUnicode(value)).toLowerCase()
      )
    )
  );
}

export function generateDirectSearchVariants(queryText: string): string[] {
  const rawQuery = normalizeTitleWhitespace(normalizeTitleUnicode(queryText));
  if (!rawQuery) {
    return [];
  }

  const semanticVariant = normalizeTitleWhitespace(
    normalizeSequelMarkersAndNumbers(
      replaceTitleEquivalents(rawQuery).toLowerCase()
    )
  );
  const romanVariant = normalizeTitleWhitespace(
    normalizeSequelMarkersAndNumbers(
      replaceTitleEquivalents(rawQuery).toLowerCase(),
      'roman'
    )
  );

  return [
    ...new Set([rawQuery, semanticVariant, romanVariant].filter(Boolean)),
  ];
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

function normalizeTitleUnicode(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{Mark}+/gu, '')
    .replace(/[’‘]/gu, "'")
    .replace(/[‐‑‒–—―]/gu, '-');
}

function replaceTitleEquivalents(value: string): string {
  let replacedValue = value;

  for (const [pattern, replacement] of TITLE_EQUIVALENT_REPLACEMENTS) {
    replacedValue = replacedValue.replace(pattern, replacement);
  }

  return replacedValue;
}

function stripTitlePunctuation(value: string): string {
  return value.replace(/[^\p{Letter}\p{Number}]+/gu, ' ');
}

function normalizeTitleWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function normalizeSequelMarkersAndNumbers(
  value: string,
  outputMode: 'arabic' | 'roman' = 'arabic'
): string {
  const sequelPattern = new RegExp(
    `\\b(${SEQUEL_MARKER_PATTERN})\\s+(${ROMAN_NUMERAL_PATTERN}|${NUMBER_WORD_PATTERN}|\\d+)\\b`,
    'giu'
  );

  return value.replace(sequelPattern, (fullMatch, marker, token) => {
    const numericValue = parseSequelNumberToken(token);
    if (numericValue === undefined) {
      return fullMatch;
    }

    const normalizedToken =
      outputMode === 'roman'
        ? integerToRoman(numericValue)
        : String(numericValue);

    return `${String(marker).toLowerCase()} ${normalizedToken}`;
  });
}

function parseSequelNumberToken(token: string): number | undefined {
  const normalizedToken = token.toLowerCase();

  if (/^\d+$/.test(normalizedToken)) {
    const parsedValue = Number.parseInt(normalizedToken, 10);
    return Number.isNaN(parsedValue) ? undefined : parsedValue;
  }

  const wordValue = NUMBER_WORD_VALUES.get(normalizedToken);
  if (wordValue !== undefined) {
    return wordValue;
  }

  return romanToInteger(normalizedToken);
}

function romanToInteger(token: string): number | undefined {
  const romanValues: Record<string, number> = {
    i: 1,
    v: 5,
    x: 10,
    l: 50,
    c: 100,
    d: 500,
    m: 1000,
  };

  let total = 0;
  let previousValue = 0;

  for (const character of token.split('').reverse()) {
    const currentValue = romanValues[character];
    if (!currentValue) {
      return undefined;
    }

    if (currentValue < previousValue) {
      total -= currentValue;
    } else {
      total += currentValue;
      previousValue = currentValue;
    }
  }

  return total > 0 ? total : undefined;
}

function integerToRoman(value: number): string {
  const romanPairs: [number, string][] = [
    [1000, 'm'],
    [900, 'cm'],
    [500, 'd'],
    [400, 'cd'],
    [100, 'c'],
    [90, 'xc'],
    [50, 'l'],
    [40, 'xl'],
    [10, 'x'],
    [9, 'ix'],
    [5, 'v'],
    [4, 'iv'],
    [1, 'i'],
  ];

  let remainingValue = value;
  let romanValue = '';

  for (const [arabicValue, romanDigit] of romanPairs) {
    while (remainingValue >= arabicValue) {
      romanValue += romanDigit;
      remainingValue -= arabicValue;
    }
  }

  return romanValue;
}
