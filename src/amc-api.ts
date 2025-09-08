import axios, { type AxiosInstance, type AxiosResponse } from 'axios';

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

  // Helper method to fetch movies from a specific endpoint
  private async fetchMoviesFromEndpoint(
    endpoint: string,
    endpointName: string
  ): Promise<AMCMovie[]> {
    try {
      const response: AxiosResponse<AMCApiResponse<{ movies: AMCMovie[] }>> =
        await this.client.get(endpoint, {
          params: {
            'page-size': 1000,
          },
        });

      const movies = response.data._embedded.movies || [];
      console.log(`Found ${movies.length} ${endpointName} movies`);
      return movies;
    } catch (error) {
      console.log(
        `Error fetching ${endpointName} movies (continuing with other searches):`,
        error.message
      );
      return [];
    }
  }

  // Fetch all movies from all endpoints once per run
  async getAllMovies(): Promise<AMCMovie[]> {
    try {
      console.log('Fetching all movies from AMC API...');

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
          endpoint.name
        );
        for (const movie of movies) {
          movieMap.set(movie.id, movie);
        }
      }

      const allMovies = Array.from(movieMap.values());
      console.log(`Total unique movies: ${allMovies.length}`);
      return allMovies;
    } catch (error) {
      console.error('Error fetching all movies:', error);
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
          'page-size': 1000, // Get all showtimes
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
      if (error.response?.status === 404) {
        console.log(
          `No showtimes available for movie ${movieId} at theatre ${theatreId}`
        );
        return [];
      }
      console.error('Error getting showtimes:', error);
      throw error;
    }
  }

  // Generate ticket purchase URL for a showtime
  generateTicketUrl(showtime: AMCShowtime): string {
    // AMC's direct showtime ticket URL format
    return `https://www.amctheatres.com/showtimes/${showtime.id}/seats`;
  }
}
