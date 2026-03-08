import { describe, expect, test } from 'bun:test';
import {
  formatShowtimeDate,
  formatShowtimeForLog,
  formatShowtimeTime,
  getShowtimeSortTimeMs,
} from './showtime-time.js';

describe('showtime-time', () => {
  test('formats AMC local showtimes without using the host timezone', () => {
    expect(
      formatShowtimeDate(
        '2017-09-21T21:05:00Z',
        '2017-09-21T16:05:00',
        '-05:00'
      )
    ).toBe('Thu, Sep 21');
    expect(
      formatShowtimeTime(
        '2017-09-21T21:05:00Z',
        '2017-09-21T16:05:00',
        '-05:00'
      )
    ).toBe('4:05 PM');
    expect(
      formatShowtimeForLog(
        '2017-09-21T21:05:00Z',
        '2017-09-21T16:05:00',
        '-05:00'
      )
    ).toBe('Thu, Sep 21 4:05 PM');
  });

  test('sorts by UTC when available', () => {
    const earlier = getShowtimeSortTimeMs(
      '2017-09-21T21:05:00Z',
      '2017-09-21T16:05:00',
      '-05:00'
    );
    const later = getShowtimeSortTimeMs(
      '2017-09-21T22:35:00Z',
      '2017-09-21T17:35:00',
      '-05:00'
    );

    expect(earlier).toBeLessThan(later);
  });

  test('falls back to local showtime plus utcOffset when utc is unavailable', () => {
    const sortTimeMs = getShowtimeSortTimeMs(
      'invalid',
      '2017-09-21T16:05:00',
      '-05:00'
    );

    expect(sortTimeMs).toBe(Date.parse('2017-09-21T16:05:00-05:00'));
  });
});
