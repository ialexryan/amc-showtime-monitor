export const STARTUP_NOTIFICATION_STATE_KEY = 'startup_notification_sent_at';
export const STARTUP_NOTIFICATION_COOLDOWN_MS = 10 * 60 * 1000;

export function shouldSendStartupNotification(
  lastSentAtIso: string | null,
  now: Date,
  cooldownMs: number = STARTUP_NOTIFICATION_COOLDOWN_MS
): boolean {
  if (!lastSentAtIso) {
    return true;
  }

  const lastSentAtMs = Date.parse(lastSentAtIso);
  if (Number.isNaN(lastSentAtMs)) {
    return true;
  }

  return now.getTime() - lastSentAtMs >= cooldownMs;
}
