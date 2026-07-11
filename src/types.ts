/**
 * An Account's configuration: its identity, Key, and waterfall Priority.
 *
 * An Account is an ElevenLabs subscription; quota belongs to the Account, not
 * the Key, so the Account (not the Key) is the pool's unit of tracking.
 */
export interface AccountConfig {
  /** Stable identifier for the Account — not the secret Key. */
  readonly id: string;
  /** The ElevenLabs API Key handed to the consumer to authenticate a Generation. */
  readonly key: string;
  /**
   * Waterfall Priority. The pool drains a higher-Priority (lower-numbered)
   * Account up to its Quota before selecting the next.
   */
  readonly priority: number;
}

/**
 * A point-in-time view of an Account's Quota state, as last seeded or Synced.
 *
 * The ElevenLabs subscription endpoint exposes these under legacy `character_*`
 * field names, but the values are Credits (see CONTEXT.md). Converting those
 * fields into this snapshot is the fetcher's job, not this type's.
 */
export interface AccountSnapshot {
  /** The Account's Credit allowance for the current billing period (`character_limit`). */
  readonly quota: number;
  /** Credits remaining, as last known. Debited on commit, refreshed on Sync. */
  readonly remaining: number;
  /** Unix milliseconds at which the Quota resets (from `next_character_count_reset_unix`). */
  readonly resetAt: number;
  /** Unix milliseconds at which this snapshot was last Synced. */
  readonly syncedAt: number;
}

/**
 * A provisional hold on an Account's Credits, taken atomically when a Key is
 * acquired so concurrent callers can't double-spend the same Account.
 * Reconciled to actual Usage on commit, or refunded on release.
 */
export interface Reservation {
  /** Unique id for this Reservation, used to commit or release it. */
  readonly id: string;
  /** The Account this Reservation is held against. */
  readonly accountId: string;
  /** Credits held. */
  readonly credits: number;
  /**
   * Unix milliseconds after which the lease has expired and the Reservation is
   * auto-released on the next access/Sync of its Account, so a caller that
   * crashed between {@link Pool.acquire} and commit/release can't permanently
   * shrink availability. `Infinity` when no lease was requested (never expires).
   */
  readonly expiresAt: number;
}

/**
 * The raw Get User Subscription payload the pool reads to seed and Sync an
 * Account. ElevenLabs exposes the balance under legacy `character_*` field
 * names, but the values are Credits (see CONTEXT.md); converting these into an
 * {@link AccountSnapshot} is the pool's job.
 *
 * Only the fields the pool depends on are modelled; the endpoint returns more.
 */
export interface Subscription {
  /** Credits consumed so far this billing period. */
  readonly character_count: number;
  /** The Account's Credit allowance for the billing period. */
  readonly character_limit: number;
  /** Unix **seconds** at which the Quota resets. */
  readonly next_character_count_reset_unix: number;
}

/**
 * Fetches an Account's live {@link Subscription} from ElevenLabs, given its Key.
 *
 * Injected so tests can substitute a fake that returns controlled balances
 * without a network call (see ADR-0001). A real ElevenLabs default is shipped
 * with the Sync work; until then the fetcher must be supplied.
 */
export type SubscriptionFetcher = (key: string) => Promise<Subscription>;

/**
 * Returns the current time as Unix milliseconds.
 *
 * Injected so tests can advance time deterministically for staleness, lease
 * expiry, and Quota-reset boundaries. Defaults to {@link Date.now}.
 */
export type Clock = () => number;

/**
 * The result of a successful {@link Pool.acquire}: the selected Account's Key
 * plus the two ways to close out the Reservation taken when it was acquired.
 *
 * `key` is a bare string ready to hand straight to an ElevenLabs client. The
 * lease exists because the Reservation must be referenced to reconcile it, and
 * a bare string can't carry that reference safely across concurrent callers —
 * so `commit`/`release` are methods on the handle (see ADR-0002).
 */
export interface KeyLease {
  /** The selected Account's API Key. */
  readonly key: string;
  /**
   * Reconcile the Reservation to the exact Credits the Generation consumed —
   * the caller reads this from ElevenLabs' `x-character-count` response header.
   * Corrects the estimate whether the true cost was higher or lower.
   */
  commit(actualCredits: number): Promise<void>;
  /**
   * Refund the Reservation in full because the Generation failed and ElevenLabs
   * charged nothing, restoring the Account's available Credits.
   */
  release(): Promise<void>;
  /**
   * Report that this Key was rejected as invalid or revoked (a 401/403 from the
   * Generation call): Quarantine the Account so it's removed from selection and
   * the operator is notified, and refund the Reservation (the Generation
   * charged nothing). The pool keeps serving from healthy Accounts.
   */
  reportInvalid(): Promise<void>;
}

/**
 * The storage seam behind the pool. It owns the atomic Credit operations, which
 * is what keeps selection correct under concurrency and across process
 * boundaries.
 *
 * The default in-memory adapter suits a single long-lived process; a shared
 * store (Redis/Upstash/KV) suits serverless with concurrent invocations. Pool
 * logic is identical across adapters (see ADR-0001).
 */
export interface StorageAdapter {
  /** Seed or overwrite an Account's snapshot (used on Sync). */
  writeSnapshot(accountId: string, snapshot: AccountSnapshot): Promise<void>;

  /** Read an Account's snapshot, or `undefined` if it has never been Synced. */
  readSnapshot(accountId: string): Promise<AccountSnapshot | undefined>;

  /**
   * Credits available to reserve right now: the snapshot's `remaining` minus the
   * sum of the Account's outstanding Reservations. Returns 0 for an Account with
   * no snapshot.
   */
  getAvailableCredits(accountId: string): Promise<number>;

  /**
   * Atomically hold `credits` against an Account. Resolves to the Reservation,
   * or `null` if the Account has fewer than `credits` available — leaving the
   * balance untouched (no partial effect).
   *
   * @param leaseMs Lifetime of the hold in milliseconds. After it elapses the
   *   Reservation is auto-released on the next access/Sync of its Account.
   *   Omit for a hold that never expires.
   * @param allowOverage When `true`, skip the availability check and hold the
   *   Credits even if the Account has fewer than `credits` left — driving it
   *   into Overage. Used only for a configured overflow Account; never resolves
   *   to `null`. Defaults to `false`.
   */
  reserve(
    accountId: string,
    credits: number,
    leaseMs?: number,
    allowOverage?: boolean,
  ): Promise<Reservation | null>;

  /**
   * Reconcile a Reservation to the actual Credits a Generation consumed: debit
   * `actualCredits` from the Account's `remaining` and drop the Reservation.
   */
  commit(reservationId: string, actualCredits: number): Promise<void>;

  /**
   * Refund a Reservation (the Generation failed and ElevenLabs charged nothing):
   * drop it, leaving `remaining` unchanged.
   */
  release(reservationId: string): Promise<void>;
}
