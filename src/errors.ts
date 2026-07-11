/**
 * Thrown by {@link Pool.acquire} when no Account has room for the reservation
 * and no overflow Account is configured — exhaustion is explicit, never a
 * silently returned Key that would tip an Account into Overage.
 *
 * A typed class (not a bare `Error`) so callers can branch on exhaustion with
 * `instanceof` and, for example, surface a "top up an Account" prompt.
 */
export class AllAccountsExhausted extends Error {
  /** The ids of the Accounts that were all out of room, in waterfall order. */
  readonly accountIds: readonly string[];

  constructor(accountIds: readonly string[]) {
    super(
      `All ${accountIds.length} Account(s) are exhausted; no Key has room to acquire.`,
    );
    this.name = 'AllAccountsExhausted';
    this.accountIds = accountIds;
  }
}

/**
 * Signals that an Account's Key is invalid or revoked (a 401/403). A consumer's
 * fetcher may throw this so a failed Sync Quarantines the Account instead of
 * being retried with backoff; {@link isAuthError} also recognises it.
 */
export class InvalidKeyError extends Error {
  /** The HTTP status that surfaced the auth failure (401 or 403). */
  readonly status: number;

  constructor(message = 'The API Key is invalid or revoked.', status = 401) {
    super(message);
    this.name = 'InvalidKeyError';
    this.status = status;
  }
}

/**
 * Whether an error represents an auth failure (401/403) that should Quarantine
 * an Account rather than be retried. Recognises an {@link InvalidKeyError} and
 * the `status` / `statusCode` shapes common to HTTP clients.
 */
export function isAuthError(error: unknown): boolean {
  if (error instanceof InvalidKeyError) {
    return true;
  }
  if (typeof error === 'object' && error !== null) {
    const { status, statusCode } = error as { status?: unknown; statusCode?: unknown };
    return status === 401 || status === 403 || statusCode === 401 || statusCode === 403;
  }
  return false;
}
