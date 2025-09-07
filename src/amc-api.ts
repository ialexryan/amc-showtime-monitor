import axios, { type AxiosInstance, type AxiosResponse } from 'axios';
import Fuse from 'fuse.js';

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

  constructor(apiKey: string) {
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
    theatreNameOrSlug: string
  ): Promise<AMCTheatre | null> {
    try {
      // Check cache first
      const cached = this.theatreCache.get(theatreNameOrSlug.toLowerCase());
      if (cached) return cached;

      console.log(`Looking up theatre: ${theatreNameOrSlug}`);

      // If it looks like a slug (contains hyphens and no spaces), try direct lookup first
      if (theatreNameOrSlug.includes('-') && !theatreNameOrSlug.includes(' ')) {
        try {
          console.log(`Attempting direct slug lookup: ${theatreNameOrSlug}`);
          const directResponse: AxiosResponse<AMCTheatre> =
            await this.client.get(`/theatres/${theatreNameOrSlug}`);
          const theatre = directResponse.data;
          console.log(`✅ Found theatre: ${theatre.name} (ID: ${theatre.id})`);

          // Cache the result
          this.theatreCache.set(theatreNameOrSlug.toLowerCase(), theatre);
          return theatre;
        } catch (_error) {
          console.log(`Direct slug lookup failed, falling back to search...`);
        }
      }

      // Use AMC's name search parameter
      console.log(`Searching by name: ${theatreNameOrSlug}`);
      const response: AxiosResponse<
        AMCApiResponse<{ theatres: AMCTheatre[] }>
      > = await this.client.get('/theatres', {
        params: {
          name: theatreNameOrSlug,
        },
      });

      const theatres = response.data._embedded.theatres || [];
      console.log(`Found ${theatres.length} theatres matching name search`);

      if (theatres.length > 0) {
        // Prefer exact matches, fall back to first result
        const exactMatch = theatres.find(
          (t) =>
            t.name.toLowerCase() === theatreNameOrSlug.toLowerCase() ||
            t.longName.toLowerCase() === theatreNameOrSlug.toLowerCase()
        );

        const selectedTheatre = exactMatch || theatres[0];
        this.theatreCache.set(theatreNameOrSlug.toLowerCase(), selectedTheatre);
        console.log(
          `✅ Found theatre: ${selectedTheatre.name} (ID: ${selectedTheatre.id})`
        );
        return selectedTheatre;
      }

      console.log(`❌ Theatre not found: ${theatreNameOrSlug}`);
      return null;
    } catch (error) {
      console.error('Error searching for theatre:', error);
      throw error;
    }
  }

  async searchMoviesByName(movieName: string): Promise<AMCMovie[]> {
    try {
      console.log(`Searching for movie: ${movieName}`);

      // Search in advance movies (upcoming releases)
      const advanceResponse: AxiosResponse<
        AMCApiResponse<{ movies: AMCMovie[] }>
      > = await this.client.get('/movies/views/advance', {
        params: {
          name: movieName,
          'page-size': 20,
        },
      });

      let movies = advanceResponse.data._embedded.movies || [];
      console.log(`Found ${movies.length} advance movies for: ${movieName}`);

      // Also search in coming soon movies
      try {
        const comingSoonResponse: AxiosResponse<
          AMCApiResponse<{ movies: AMCMovie[] }>
        > = await this.client.get('/movies/views/coming-soon', {
          params: {
            name: movieName,
            'page-size': 20,
          },
        });

        const comingSoonMovies = comingSoonResponse.data._embedded.movies || [];
        console.log(
          `Found ${comingSoonMovies.length} coming-soon movies for: ${movieName}`
        );

        // Merge results, avoiding duplicates
        const existingIds = new Set(movies.map((m) => m.id));
        const newMovies = comingSoonMovies.filter(
          (m) => !existingIds.has(m.id)
        );
        movies = [...movies, ...newMovies];
      } catch (error) {
        console.log(
          'Error searching coming-soon movies (continuing with advance movies):',
          error.message
        );
      }

      // Use fuzzy matching to filter results
      if (movies.length > 0) {
        const fuse = new Fuse(movies, {
          keys: ['name'],
          threshold: 0.6, // More relaxed threshold to catch "The Movie" vs "Movie"
          includeScore: true,
        });

        const fuzzyResults = fuse.search(movieName);
        const filteredMovies = fuzzyResults
          .filter((result) => (result.score ?? 1) < 0.7) // More lenient scoring for articles like "The"
          .map((result) => result.item);

        console.log(`Filtered to ${filteredMovies.length} relevant movies`);
        if (filteredMovies.length > 0) {
          console.log(
            `Best matches:`,
            filteredMovies.map(
              (m) =>
                `${m.name} (score: ${fuzzyResults.find((r) => r.item.id === m.id)?.score?.toFixed(3)})`
            )
          );
        }
        return filteredMovies;
      }

      return movies;
    } catch (error) {
      console.error('Error searching for movies:', error);
      throw error;
    }
  }

  async getShowtimesForMovieAtTheatre(
    movieId: number,
    theatreId: number
  ): Promise<AMCShowtime[]> {
    try {
      console.log(
        `Getting showtimes for movie ${movieId} at theatre ${theatreId}`
      );

      const response: AxiosResponse<
        AMCApiResponse<{ showtimes: AMCShowtime[] }>
      > = await this.client.get(`/theatres/${theatreId}/showtimes`, {
        params: {
          'movie-id': movieId,
          'page-size': 100, // Get all showtimes
        },
      });

      const showtimes = response.data._embedded.showtimes || [];
      console.log(`Found ${showtimes.length} showtimes`);

      // Filter out past showtimes (only future ones)
      const now = new Date();
      const futureShowtimes = showtimes.filter((showtime) => {
        const showDate = new Date(showtime.showDateTimeUtc);
        return showDate > now;
      });

      console.log(`${futureShowtimes.length} future showtimes after filtering`);
      return futureShowtimes;
    } catch (error) {
      console.error('Error getting showtimes:', error);
      throw error;
    }
  }

  async getAllFutureShowtimesAtTheatre(
    theatreId: number
  ): Promise<AMCShowtime[]> {
    try {
      console.log(`Getting all future showtimes at theatre ${theatreId}`);

      const response: AxiosResponse<
        AMCApiResponse<{ showtimes: AMCShowtime[] }>
      > = await this.client.get(`/theatres/${theatreId}/showtimes`, {
        params: {
          'page-size': 100,
        },
      });

      const showtimes = response.data._embedded.showtimes || [];

      // Filter out past showtimes
      const now = new Date();
      const futureShowtimes = showtimes.filter((showtime) => {
        const showDate = new Date(showtime.showDateTimeUtc);
        return showDate > now;
      });

      console.log(`Found ${futureShowtimes.length} future showtimes`);
      return futureShowtimes;
    } catch (error) {
      console.error('Error getting all showtimes:', error);
      throw error;
    }
  }

  // Generate ticket purchase URL for a showtime
  generateTicketUrl(showtime: AMCShowtime): string {
    // AMC's direct showtime ticket URL format
    return `https://www.amctheatres.com/showtimes/${showtime.id}/seats`;
  }
}
