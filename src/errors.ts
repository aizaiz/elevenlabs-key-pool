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
