const LOCAL_SHOWTIME_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

function getParsedUtcDate(showDateTimeUtc: string): Date | null {
  const parsedUtcDate = new Date(showDateTimeUtc);
  return Number.isNaN(parsedUtcDate.getTime()) ? null : parsedUtcDate;
}

function getFallbackLocalDate(
  showDateTimeLocal: string,
  utcOffset?: string
): Date | null {
  if (utcOffset) {
    const localWithOffsetDate = new Date(`${showDateTimeLocal}${utcOffset}`);
    if (!Number.isNaN(localWithOffsetDate.getTime())) {
      return localWithOffsetDate;
    }
  }

  const match = LOCAL_SHOWTIME_PATTERN.exec(showDateTimeLocal);
  if (!match) {
    return null;
  }

  const [, year, month, day, hour, minute, second = '00'] = match;
  const syntheticUtcDate = new Date(
    Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second)
    )
  );

  return Number.isNaN(syntheticUtcDate.getTime()) ? null : syntheticUtcDate;
}

function getDisplayTimeZone(utcOffset?: string): string {
  if (utcOffset) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: utcOffset }).format(
        new Date(0)
      );
      return utcOffset;
    } catch {
      // Fall back to UTC formatting below.
    }
  }

  return 'UTC';
}

function getDisplayDate(
  showDateTimeUtc: string,
  showDateTimeLocal: string,
  utcOffset?: string
): Date | null {
  return (
    getParsedUtcDate(showDateTimeUtc) ??
    getFallbackLocalDate(showDateTimeLocal, utcOffset)
  );
}

function formatWithParts(
  showDateTimeUtc: string,
  showDateTimeLocal: string,
  utcOffset: string | undefined,
  options: Intl.DateTimeFormatOptions
): Intl.DateTimeFormatPart[] | null {
  const displayDate = getDisplayDate(
    showDateTimeUtc,
    showDateTimeLocal,
    utcOffset
  );
  if (!displayDate) {
    return null;
  }

  return new Intl.DateTimeFormat('en-US', {
    ...options,
    timeZone: getDisplayTimeZone(utcOffset),
  }).formatToParts(displayDate);
}

export function formatShowtimeDate(
  showDateTimeUtc: string,
  showDateTimeLocal: string,
  utcOffset?: string
): string {
  const parts = formatWithParts(showDateTimeUtc, showDateTimeLocal, utcOffset, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });

  if (!parts) {
    return showDateTimeLocal;
  }

  const weekday = parts.find((part) => part.type === 'weekday')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  const day = parts.find((part) => part.type === 'day')?.value;

  if (!weekday || !month || !day) {
    return showDateTimeLocal;
  }

  return `${weekday}, ${month} ${day}`;
}

export function formatShowtimeTime(
  showDateTimeUtc: string,
  showDateTimeLocal: string,
  utcOffset?: string
): string {
  const parts = formatWithParts(showDateTimeUtc, showDateTimeLocal, utcOffset, {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });

  if (!parts) {
    return showDateTimeLocal;
  }

  const hour = parts.find((part) => part.type === 'hour')?.value;
  const minute = parts.find((part) => part.type === 'minute')?.value;
  const dayPeriod = parts.find((part) => part.type === 'dayPeriod')?.value;

  if (!hour || !minute || !dayPeriod) {
    return showDateTimeLocal;
  }

  return `${hour}:${minute} ${dayPeriod}`;
}

export function formatShowtimeForLog(
  showDateTimeUtc: string,
  showDateTimeLocal: string,
  utcOffset?: string
): string {
  return `${formatShowtimeDate(showDateTimeUtc, showDateTimeLocal, utcOffset)} ${formatShowtimeTime(showDateTimeUtc, showDateTimeLocal, utcOffset)}`;
}

export function getShowtimeSortTimeMs(
  showDateTimeUtc: string,
  showDateTimeLocal: string,
  utcOffset?: string
): number {
  const displayDate =
    getParsedUtcDate(showDateTimeUtc) ??
    getFallbackLocalDate(showDateTimeLocal, utcOffset);

  return displayDate ? displayDate.getTime() : Number.MAX_SAFE_INTEGER;
}
