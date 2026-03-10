import { describe, expect, test } from 'bun:test';
import {
  STARTUP_NOTIFICATION_COOLDOWN_MS,
  shouldSendStartupNotification,
} from './startup-notification.js';

describe('startup-notification', () => {
  test('sends when no prior startup notification exists', () => {
    expect(
      shouldSendStartupNotification(null, new Date('2026-03-10T21:00:00.000Z'))
    ).toBe(true);
  });

  test('suppresses repeated startup notifications inside the cooldown window', () => {
    const now = new Date('2026-03-10T21:10:00.000Z');
    const lastSentAt = new Date(
      now.getTime() - STARTUP_NOTIFICATION_COOLDOWN_MS + 1_000
    ).toISOString();

    expect(shouldSendStartupNotification(lastSentAt, now)).toBe(false);
  });

  test('allows a new startup notification after the cooldown window elapses', () => {
    const now = new Date('2026-03-10T21:10:00.000Z');
    const lastSentAt = new Date(
      now.getTime() - STARTUP_NOTIFICATION_COOLDOWN_MS
    ).toISOString();

    expect(shouldSendStartupNotification(lastSentAt, now)).toBe(true);
  });

  test('treats invalid persisted timestamps as eligible to send', () => {
    expect(
      shouldSendStartupNotification(
        'not-a-timestamp',
        new Date('2026-03-10T21:00:00.000Z')
      )
    ).toBe(true);
  });
});
