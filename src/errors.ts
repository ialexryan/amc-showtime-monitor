export class HttpStatusError extends Error {
  constructor(
    public readonly status: number,
    message: string = `HTTP ${status}`
  ) {
    super(message);
    this.name = 'HttpStatusError';
  }
}

export class RequestTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`request timed out after ${timeoutMs}ms`);
    this.name = 'RequestTimeoutError';
  }
}

export function getErrorMessage(error: unknown): string {
  if (
    typeof error === 'object' &&
    error !== null &&
    'description' in error &&
    typeof error.description === 'string'
  ) {
    return error.description;
  }

  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export function getErrorStack(error: unknown): string | undefined {
  if (error instanceof Error) {
    return error.stack;
  }
  return undefined;
}

export function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'AbortError') {
    return true;
  }

  return error instanceof Error && error.name === 'AbortError';
}

export function isRateLimitError(error: unknown): boolean {
  if (error instanceof HttpStatusError) {
    return error.status === 429;
  }

  return (
    error instanceof Error &&
    error.message.toLowerCase().includes('rate limited by amc api')
  );
}

export function isTransientError(error: unknown): boolean {
  if (isAbortError(error)) {
    return false;
  }

  if (error instanceof HttpStatusError) {
    return error.status >= 500;
  }

  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return (
    message.includes('timeout') ||
    message.includes('network') ||
    message.includes('socket') ||
    message.includes('temporarily unavailable')
  );
}
