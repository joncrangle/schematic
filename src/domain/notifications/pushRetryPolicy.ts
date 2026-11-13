/**
 * Push-service retry policy. The first retry waits two minutes, then each
 * consecutive rejection doubles the delay up to one hour. 429 Retry-After
 * values are honored up to one day so a provider cannot create an unbounded
 * suspension.
 */
export const PUSH_RETRY_BASE_DELAY_MS = 60_000;
export const PUSH_RETRY_MAX_DELAY_MS = 60 * 60_000;
export const PUSH_RETRY_AFTER_MAX_MS = 24 * 60 * 60_000;
export const PUSH_RETRY_COUNT_LIMIT = 31;
export const PUSH_HARD_FAILURE_LIMIT = 5;

export function pushRetryDelayMs(nextFailureCount: number): number {
  const exponent = Math.max(1, Math.min(6, Math.trunc(nextFailureCount)));
  return Math.min(PUSH_RETRY_MAX_DELAY_MS, PUSH_RETRY_BASE_DELAY_MS * 2 ** exponent);
}

export function parsePushRetryAfterAt(value: string | null, now: number): number | undefined {
  if (!value) return undefined;
  const seconds = /^\d+$/.test(value.trim()) ? Number(value.trim()) : undefined;
  const rawDelay = seconds === undefined ? Date.parse(value) - now : seconds * 1000;
  if (!Number.isFinite(rawDelay)) return undefined;
  const boundedDelay = Math.min(PUSH_RETRY_AFTER_MAX_MS, Math.max(0, rawDelay));
  return now + boundedDelay;
}

export function shouldRetryPushStatus(statusCode: number): boolean {
  return (
    statusCode === 0 ||
    statusCode === 408 ||
    statusCode === 425 ||
    statusCode === 429 ||
    statusCode >= 500
  );
}

export function shouldCountHardPushFailure(statusCode: number, credentialFailure = false): boolean {
  return (
    !credentialFailure &&
    statusCode >= 400 &&
    statusCode < 500 &&
    !shouldRetryPushStatus(statusCode) &&
    statusCode !== 404 &&
    // A bare 401 indicates missing or rejected VAPID authorization, not a
    // subscription that has proven itself permanently invalid.
    statusCode !== 401 &&
    statusCode !== 410 &&
    statusCode !== 413
  );
}
