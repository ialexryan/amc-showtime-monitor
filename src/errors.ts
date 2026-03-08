import axios from 'axios';

export function getErrorMessage(error: unknown): string {
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

  if (axios.isAxiosError(error)) {
    return error.code === 'ERR_CANCELED';
  }

  return error instanceof Error && error.name === 'AbortError';
}

export function isRateLimitError(error: unknown): boolean {
  if (axios.isAxiosError(error)) {
    return error.response?.status === 429;
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

  if (axios.isAxiosError(error)) {
    if (!error.response) {
      return true;
    }

    return error.response.status >= 500;
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
