import axios, { type AxiosInstance, type AxiosResponse } from 'axios';
import { getErrorMessage } from './errors.js';

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

export class AMCApiClient {
  private client: AxiosInstance;
  private theatreCache = new Map<string, AMCTheatre>();

  constructor(
    apiKey: string,
    private logger?: AMCApiLogger
  ) {
    this.client = axios.create({
      baseURL: 'https://api.amctheatres.com/v2',
      headers: {
        'X-AMC-Vendor-Key': apiKey,
        'User-Agent': 'AMC-Showtime-Monitor/1.0',
        Accept: 'application/json',
      },
      timeout: 10000, // 10 second timeout
    });

    // Add response interceptor for error handling
    this.client.interceptors.response.use(
      (response) => response,
      (error) => {
        if (error.response?.status === 429) {
          throw new Error(
            'Rate limited by AMC API. Please reduce polling frequency.'
          );
        }
        if (error.response?.status === 401 || error.response?.status === 403) {
          throw new Error('Invalid AMC API key or access denied.');
        }
        throw error;
      }
    );
  }

  async findTheatreByName(
    theatreNameOrSlug: string,
    signal?: AbortSignal
  ): Promise<AMCTheatre | null> {
    try {
      // Check cache first
      const cached = this.theatreCache.get(theatreNameOrSlug.toLowerCase());
      if (cached) return cached;

      this.info(`Looking up theatre: ${theatreNameOrSlug}`, {
        theatre: theatreNameOrSlug,
      });

      // If it looks like a slug (contains hyphens and no spaces), try direct lookup first
      if (theatreNameOrSlug.includes('-') && !theatreNameOrSlug.includes(' ')) {
        try {
          this.info(`Attempting direct slug lookup: ${theatreNameOrSlug}`, {
            theatre: theatreNameOrSlug,
          });
          const directResponse: AxiosResponse<AMCTheatre> =
            await this.client.get(`/theatres/${theatreNameOrSlug}`, {
              ...(signal ? { signal } : {}),
            });
          const theatre = directResponse.data;

          // Cache the result
          this.theatreCache.set(theatreNameOrSlug.toLowerCase(), theatre);
          return theatre;
        } catch {
          this.warn('Direct slug lookup failed, falling back to search...', {
            theatre: theatreNameOrSlug,
          });
        }
      }

      // Use AMC's name search parameter
      this.info(`Searching by name: ${theatreNameOrSlug}`, {
        theatre: theatreNameOrSlug,
      });
      const response: AxiosResponse<
        AMCApiResponse<{ theatres: AMCTheatre[] }>
      > = await this.client.get('/theatres', {
        params: {
          name: theatreNameOrSlug,
        },
        ...(signal ? { signal } : {}),
      });

      const theatres = response.data._embedded.theatres || [];
      this.info(`Found ${theatres.length} theatres matching name search`, {
        theatre: theatreNameOrSlug,
        data: { count: theatres.length },
      });

      if (theatres.length > 0) {
        // Prefer exact matches, fall back to first result
        const exactMatch = theatres.find(
          (t) =>
            t.name.toLowerCase() === theatreNameOrSlug.toLowerCase() ||
            t.longName.toLowerCase() === theatreNameOrSlug.toLowerCase()
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

  // Helper method to fetch movies from a specific endpoint
  private async fetchMoviesFromEndpoint(
    endpoint: string,
    endpointName: string,
    signal?: AbortSignal
  ): Promise<AMCMovie[]> {
    try {
      const response: AxiosResponse<AMCApiResponse<{ movies: AMCMovie[] }>> =
        await this.client.get(endpoint, {
          params: {
            'page-size': 1000,
          },
          ...(signal ? { signal } : {}),
        });

      const movies = response.data._embedded.movies || [];
      this.info(`Found ${movies.length} ${endpointName} movies`, {
        data: {
          endpoint,
          endpointName,
          count: movies.length,
        },
      });
      return movies;
    } catch (error) {
      const message = getErrorMessage(error);
      this.warn(
        `Error fetching ${endpointName} movies (continuing with other searches): ${message}`,
        {
          data: {
            endpoint,
            endpointName,
          },
        }
      );
      return [];
    }
  }

  // Fetch all movies from all endpoints once per run
  async getAllMovies(signal?: AbortSignal): Promise<AMCMovie[]> {
    try {
      this.info('Fetching all movies from AMC API...');

      const movieMap = new Map<number, AMCMovie>();

      // Fetch movies from all endpoints
      const endpoints = [
        { path: '/movies/views/advance', name: 'advance' },
        { path: '/movies/views/now-playing', name: 'now-playing' },
        { path: '/movies/views/coming-soon', name: 'coming-soon' },
      ];

      for (const endpoint of endpoints) {
        const movies = await this.fetchMoviesFromEndpoint(
          endpoint.path,
          endpoint.name,
          signal
        );
        for (const movie of movies) {
          movieMap.set(movie.id, movie);
        }
      }

      const allMovies = Array.from(movieMap.values());
      this.info(`Total unique movies: ${allMovies.length}`, {
        data: { count: allMovies.length },
      });
      return allMovies;
    } catch (error) {
      this.error(`Error fetching all movies: ${getErrorMessage(error)}`);
      throw error;
    }
  }

  async getShowtimesForMovieAtTheatre(
    movieId: number,
    theatreId: number,
    signal?: AbortSignal
  ): Promise<AMCShowtime[]> {
    try {
      this.info(
        `Getting showtimes for movie ${movieId} at theatre ${theatreId}`,
        {
          data: { movieId, theatreId },
        }
      );

      const response: AxiosResponse<
        AMCApiResponse<{ showtimes: AMCShowtime[] }>
      > = await this.client.get(`/theatres/${theatreId}/showtimes`, {
        params: {
          'movie-id': movieId,
          'page-size': 1000, // Get all showtimes
        },
        ...(signal ? { signal } : {}),
      });

      const showtimes = response.data._embedded.showtimes || [];
      this.info(`Found ${showtimes.length} showtimes`, {
        data: {
          movieId,
          theatreId,
          count: showtimes.length,
        },
      });

      // Filter out past showtimes (only future ones)
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
        },
      });
      return futureShowtimes;
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        this.info(
          `No showtimes available for movie ${movieId} at theatre ${theatreId}`,
          {
            data: { movieId, theatreId },
          }
        );
        return [];
      }
      this.error(`Error getting showtimes: ${getErrorMessage(error)}`, {
        data: { movieId, theatreId },
      });
      throw error;
    }
  }

  // Generate ticket purchase URL for a showtime
  generateTicketUrl(showtime: AMCShowtime): string {
    // AMC's direct showtime ticket URL format
    return `https://www.amctheatres.com/showtimes/${showtime.id}/seats`;
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
