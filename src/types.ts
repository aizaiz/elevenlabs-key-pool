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
   */
  reserve(accountId: string, credits: number): Promise<Reservation | null>;

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
