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

  async findTheatreByName(theatreName: string): Promise<AMCTheatre | null> {
    try {
      // Check cache first
      const cached = this.theatreCache.get(theatreName.toLowerCase());
      if (cached) return cached;

      console.log(`Searching for theatre: ${theatreName}`);

      // Get all theatres (AMC API doesn't seem to support name filtering)
      const response: AxiosResponse<
        AMCApiResponse<{ theatres: AMCTheatre[] }>
      > = await this.client.get('/theatres', {
        params: {
          'page-size': 100, // Get more results to improve matching
        },
      });

      const theatres = response.data._embedded.theatres;

      // Use fuzzy search to find the best match
      const fuse = new Fuse(theatres, {
        keys: ['name', 'longName', 'slug'],
        threshold: 0.4, // Allow some fuzziness
        includeScore: true,
      });

      const results = fuse.search(theatreName);
      if (results.length > 0 && (results[0].score ?? 1) < 0.5) {
        const theatre = results[0].item;
        // Cache the result
        this.theatreCache.set(theatreName.toLowerCase(), theatre);
        console.log(`Found theatre: ${theatre.name} (ID: ${theatre.id})`);
        return theatre;
      }

      // If no good fuzzy match, try exact partial matches
      const exactMatch = theatres.find(
        (t) =>
          t.name.toLowerCase().includes(theatreName.toLowerCase()) ||
          t.longName.toLowerCase().includes(theatreName.toLowerCase())
      );

      if (exactMatch) {
        this.theatreCache.set(theatreName.toLowerCase(), exactMatch);
        console.log(`Found theatre: ${exactMatch.name} (ID: ${exactMatch.id})`);
        return exactMatch;
      }

      console.log(`No theatre found matching: ${theatreName}`);
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
          threshold: 0.3, // More strict matching for movies
          includeScore: true,
        });

        const fuzzyResults = fuse.search(movieName);
        const filteredMovies = fuzzyResults
          .filter((result) => (result.score ?? 1) < 0.4) // Only good matches
          .map((result) => result.item);

        console.log(`Filtered to ${filteredMovies.length} relevant movies`);
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
  generateTicketUrl(showtime: AMCShowtime, theatreSlug: string): string {
    // AMC's ticket URL format (this may need adjustment based on their actual URL structure)
    const baseUrl = 'https://www.amctheatres.com/movie-theatres';
    const date = new Date(showtime.showDateTimeLocal);
    const dateStr = date.toISOString().split('T')[0]; // YYYY-MM-DD format

    return `${baseUrl}/${theatreSlug}/showtimes/${dateStr}`;
  }
}
