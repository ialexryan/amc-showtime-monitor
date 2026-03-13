import {
  getErrorMessage,
  HttpStatusError,
  RequestTimeoutError,
} from './errors.js';

interface AMCApiLogOptions {
  movie?: string;
  theatre?: string;
  data?: unknown;
}

interface AMCApiLogger {
  info(message: string, options?: AMCApiLogOptions): void;
  warn(message: string, options?: AMCApiLogOptions): void;
  error(message: string, options?: AMCApiLogOptions): void;
}

export interface AMCTheatre {
  id: number;
  name: string;
  longName: string;
  slug: string;
  location: {
    addressLine1: string;
    addressLine2?: string;
    city: string;
    state: string;
    postalCode: string;
    latitude: number;
    longitude: number;
  };
}

export interface AMCMovie {
  id: number;
  name: string;
  slug: string;
  genre?: string;
  mpaaRating?: string;
  runTime?: number;
  releaseDateUtc?: string;
  hasScheduledShowtimes?: boolean;
  attributes?: Array<{
    code: string;
    name: string;
    description: string;
  }>;
}

export interface AMCShowtime {
  id: number;
  movieId: number;
  movieName: string;
  showDateTimeUtc: string;
  showDateTimeLocal: string;
  utcOffset?: string;
  theatreId: number;
  auditorium: number;
  isSoldOut: boolean;
  isAlmostSoldOut: boolean;
  attributes: Array<{
    code: string;
    name: string;
    description?: string;
  }>;
  ticketPrices?: Array<{
    priceType: string;
    price: number;
  }>;
}

export interface AMCApiResponse<T> {
  pageSize: number;
  pageNumber: number;
  count: number;
  _embedded: T;
}

const AMC_API_BASE_URL = 'https://api.amctheatres.com/v2';

export class AMCApiClient {
  private readonly theatreCache = new Map<string, AMCTheatre>();
  private readonly requestTimeoutMs = 5_000;
  private readonly requestHeaders: Record<string, string>;

  constructor(
    apiKey: string,
    private logger?: AMCApiLogger
  ) {
    this.requestHeaders = {
      'X-AMC-Vendor-Key': apiKey,
      'User-Agent': 'AMC-Showtime-Monitor/1.0',
      Accept: 'application/json',
    };
  }

  async findTheatreByName(
    theatreNameOrSlug: string,
    signal?: AbortSignal
  ): Promise<AMCTheatre | null> {
    try {
      const cached = this.theatreCache.get(theatreNameOrSlug.toLowerCase());
      if (cached) {
        return cached;
      }

      this.info(`Looking up theatre: ${theatreNameOrSlug}`, {
        theatre: theatreNameOrSlug,
      });

      if (theatreNameOrSlug.includes('-') && !theatreNameOrSlug.includes(' ')) {
        try {
          this.info(`Attempting direct slug lookup: ${theatreNameOrSlug}`, {
            theatre: theatreNameOrSlug,
          });
          const theatre = await this.fetchJson<AMCTheatre>(
            `/theatres/${theatreNameOrSlug}`,
            undefined,
            signal
          );

          this.theatreCache.set(theatreNameOrSlug.toLowerCase(), theatre);
          return theatre;
        } catch {
          this.warn('Direct slug lookup failed, falling back to search...', {
            theatre: theatreNameOrSlug,
          });
        }
      }

      this.info(`Searching by name: ${theatreNameOrSlug}`, {
        theatre: theatreNameOrSlug,
      });
      const response = await this.fetchJson<
        AMCApiResponse<{ theatres: AMCTheatre[] }>
      >(
        '/theatres',
        {
          name: theatreNameOrSlug,
        },
        signal
      );

      const theatres = response._embedded.theatres || [];
      this.info(`Found ${theatres.length} theatres matching name search`, {
        theatre: theatreNameOrSlug,
        data: { count: theatres.length },
      });

      if (theatres.length > 0) {
        const exactMatch = theatres.find(
          (theatre) =>
            theatre.name.toLowerCase() === theatreNameOrSlug.toLowerCase() ||
            theatre.longName.toLowerCase() === theatreNameOrSlug.toLowerCase()
        );

        const selectedTheatre = exactMatch ?? theatres[0];
        if (!selectedTheatre) {
          this.warn(`❌ Theatre not found: ${theatreNameOrSlug}`, {
            theatre: theatreNameOrSlug,
          });
          return null;
        }

        this.theatreCache.set(theatreNameOrSlug.toLowerCase(), selectedTheatre);
        return selectedTheatre;
      }

      this.warn(`❌ Theatre not found: ${theatreNameOrSlug}`, {
        theatre: theatreNameOrSlug,
      });
      return null;
    } catch (error) {
      this.error(`Error searching for theatre: ${getErrorMessage(error)}`, {
        theatre: theatreNameOrSlug,
      });
      throw error;
    }
  }

  private async fetchMoviesFromEndpoint(
    endpoint: string,
    endpointName: string,
    signal?: AbortSignal
  ): Promise<AMCMovie[]> {
    const startedAt = Date.now();

    try {
      this.info(`Fetching ${endpointName} movies from AMC API...`, {
        data: {
          endpoint,
          endpointName,
          timeoutMs: this.requestTimeoutMs,
        },
      });

      const response = await this.fetchJson<
        AMCApiResponse<{ movies: AMCMovie[] }>
      >(
        endpoint,
        {
          'page-size': 1000,
        },
        signal
      );

      const movies = response._embedded.movies || [];
      const durationMs = Date.now() - startedAt;
      this.info(
        `Found ${movies.length} ${endpointName} movies in ${durationMs}ms`,
        {
          data: {
            endpoint,
            endpointName,
            count: movies.length,
            durationMs,
          },
        }
      );
      return movies;
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      const timedOut = error instanceof RequestTimeoutError;
      const message =
        timedOut && error instanceof RequestTimeoutError
          ? `request timed out after ${durationMs}ms`
          : getErrorMessage(error);
      this.warn(
        `Error fetching ${endpointName} movies (continuing with other searches): ${message}`,
        {
          data: {
            endpoint,
            endpointName,
            durationMs,
            timedOut,
          },
        }
      );
      return [];
    }
  }

  async getAllMovies(signal?: AbortSignal): Promise<AMCMovie[]> {
    const startedAt = Date.now();
    try {
      this.info('Fetching all movies from AMC API...');

      const movieMap = new Map<number, AMCMovie>();
      const endpoints = [
        { path: '/movies/views/advance', name: 'advance' },
        { path: '/movies/views/now-playing', name: 'now-playing' },
        { path: '/movies/views/coming-soon', name: 'coming-soon' },
      ];

      const endpointResults = await Promise.all(
        endpoints.map((endpoint) =>
          this.fetchMoviesFromEndpoint(endpoint.path, endpoint.name, signal)
        )
      );

      for (const movies of endpointResults) {
        for (const movie of movies) {
          movieMap.set(movie.id, movie);
        }
      }

      const allMovies = Array.from(movieMap.values());
      const durationMs = Date.now() - startedAt;
      this.info(
        `Total unique movies: ${allMovies.length} (fetched in ${durationMs}ms)`,
        {
          data: {
            count: allMovies.length,
            durationMs,
          },
        }
      );
      return allMovies;
    } catch (error) {
      this.error(`Error fetching all movies: ${getErrorMessage(error)}`, {
        data: {
          durationMs: Date.now() - startedAt,
        },
      });
      throw error;
    }
  }

  async getShowtimesForMovieAtTheatre(
    movieId: number,
    theatreId: number,
    signal?: AbortSignal
  ): Promise<AMCShowtime[]> {
    const startedAt = Date.now();

    try {
      this.info(
        `Getting showtimes for movie ${movieId} at theatre ${theatreId}`,
        {
          data: {
            movieId,
            theatreId,
            timeoutMs: this.requestTimeoutMs,
          },
        }
      );

      const response = await this.fetchJson<
        AMCApiResponse<{ showtimes: AMCShowtime[] }>
      >(
        `/theatres/${theatreId}/showtimes`,
        {
          'movie-id': movieId,
          'page-size': 1000,
        },
        signal
      );

      const showtimes = response._embedded.showtimes || [];
      const durationMs = Date.now() - startedAt;
      this.info(`Found ${showtimes.length} showtimes in ${durationMs}ms`, {
        data: {
          movieId,
          theatreId,
          count: showtimes.length,
          durationMs,
        },
      });

      const now = new Date();
      const futureShowtimes = showtimes.filter((showtime) => {
        const showDate = new Date(showtime.showDateTimeUtc);
        return showDate > now;
      });

      this.info(`${futureShowtimes.length} future showtimes after filtering`, {
        data: {
          movieId,
          theatreId,
          count: futureShowtimes.length,
          durationMs,
        },
      });
      return futureShowtimes;
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      if (error instanceof HttpStatusError && error.status === 404) {
        this.info(
          `No showtimes available for movie ${movieId} at theatre ${theatreId} (${durationMs}ms)`,
          {
            data: { movieId, theatreId, durationMs },
          }
        );
        return [];
      }

      const timedOut = error instanceof RequestTimeoutError;
      const message =
        timedOut && error instanceof RequestTimeoutError
          ? `request timed out after ${durationMs}ms`
          : getErrorMessage(error);
      this.error(`Error getting showtimes: ${message}`, {
        data: { movieId, theatreId, durationMs, timedOut },
      });
      throw timedOut ? new RequestTimeoutError(durationMs) : error;
    }
  }

  generateTicketUrl(showtime: AMCShowtime): string {
    return `https://www.amctheatres.com/showtimes/${showtime.id}/seats`;
  }

  private async fetchJson<T>(
    path: string,
    params?: Record<string, string | number>,
    signal?: AbortSignal
  ): Promise<T> {
    const { requestSignal, timeoutSignal } = this.createRequestSignals(signal);
    const url = new URL(path, AMC_API_BASE_URL);

    if (params) {
      for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, String(value));
      }
    }

    let response: Response;
    try {
      response = await fetch(url, {
        headers: this.requestHeaders,
        signal: requestSignal,
      });
    } catch (error) {
      if (timeoutSignal.aborted && !signal?.aborted) {
        throw new RequestTimeoutError(this.requestTimeoutMs);
      }
      throw error;
    }

    if (response.status === 429) {
      throw new Error(
        'Rate limited by AMC API. Please reduce polling frequency.'
      );
    }

    if (response.status === 401 || response.status === 403) {
      throw new Error('Invalid AMC API key or access denied.');
    }

    if (!response.ok) {
      throw new HttpStatusError(
        response.status,
        `AMC API request failed with HTTP ${response.status}`
      );
    }

    try {
      return (await response.json()) as T;
    } catch (error) {
      if (timeoutSignal.aborted && !signal?.aborted) {
        throw new RequestTimeoutError(this.requestTimeoutMs);
      }
      throw new Error(
        `Failed to parse AMC API response: ${getErrorMessage(error)}`
      );
    }
  }

  private createRequestSignals(signal?: AbortSignal): {
    requestSignal: AbortSignal;
    timeoutSignal: AbortSignal;
  } {
    const timeoutSignal = AbortSignal.timeout(this.requestTimeoutMs);
    return {
      requestSignal: signal
        ? AbortSignal.any([signal, timeoutSignal])
        : timeoutSignal,
      timeoutSignal,
    };
  }

  private info(message: string, options?: AMCApiLogOptions): void {
    if (this.logger) {
      this.logger.info(message, options);
      return;
    }
    console.log(message);
  }

  private warn(message: string, options?: AMCApiLogOptions): void {
    if (this.logger) {
      this.logger.warn(message, options);
      return;
    }
    console.warn(message);
  }

  private error(message: string, options?: AMCApiLogOptions): void {
    if (this.logger) {
      this.logger.error(message, options);
      return;
    }
    console.error(message);
  }
}
