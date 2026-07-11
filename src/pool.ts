import { InMemoryStorageAdapter } from './adapters/memory.js';
import { AllAccountsExhausted } from './errors.js';
import type {
  AccountConfig,
  AccountSnapshot,
  Clock,
  KeyLease,
  StorageAdapter,
  Subscription,
  SubscriptionFetcher,
} from './types.js';

/**
 * Credits reserved by {@link Pool.acquire} when the caller gives no estimate.
 * Positive by default so concurrent selection stays safe without an estimate
 * (ADR-0002); set {@link PoolConfig.fallbackBlock} to tune it.
 */
export const DEFAULT_FALLBACK_BLOCK = 1000;

/**
 * Lifetime of a Reservation's lease when {@link PoolConfig.leaseTtl} is unset.
 * A Reservation neither committed nor released within this window is
 * auto-released on the next access/Sync of its Account, so a caller that
 * crashed between {@link Pool.acquire} and commit/release (common in
 * serverless) doesn't permanently shrink availability. 60s by default.
 */
export const DEFAULT_LEASE_TTL = 60_000;

/**
 * How long an Account's snapshot is trusted before {@link Pool.acquire} lazily
 * re-Syncs it (ADR-0001 — no in-process timers; refresh is lazy or explicit).
 * 5 minutes by default; tune with {@link PoolConfig.stalenessTtl}.
 */
export const DEFAULT_STALENESS_TTL = 300_000;

/**
 * Fraction of an Account's Quota at or below which its remaining Credits count
 * as **near the limit**, forcing a blocking Sync before selection regardless of
 * staleness — that's exactly where stale data would risk an Overage. 0.1 by
 * default; tune with {@link PoolConfig.nearLimitThreshold}.
 */
export const DEFAULT_NEAR_LIMIT_THRESHOLD = 0.1;

/**
 * How many times a failed Sync is retried (after the first attempt) before the
 * pool gives up and keeps the last-known snapshot. Tune with
 * {@link PoolConfig.syncRetries}.
 */
export const DEFAULT_SYNC_RETRIES = 3;

/**
 * Base backoff in milliseconds between Sync retries; the delay doubles each
 * attempt. Tune with {@link PoolConfig.syncBackoff}.
 */
export const DEFAULT_SYNC_BACKOFF = 200;

/** Everything needed to construct a {@link Pool}. */
export interface PoolConfig {
  /** The Accounts to spread usage across. At least one is required. */
  readonly accounts: readonly AccountConfig[];
  /**
   * Fetches an Account's live balance from ElevenLabs. Injected so tests can
   * substitute a fake. A real default arrives with the Sync work; until then,
   * omitting it makes the first {@link Pool.acquire} throw.
   */
  readonly fetcher?: SubscriptionFetcher;
  /** Current time as Unix milliseconds. Defaults to {@link Date.now}. */
  readonly clock?: Clock;
  /** Where Credit balances and Reservations live. Defaults to in-memory. */
  readonly storage?: StorageAdapter;
  /**
   * Credits to reserve when {@link Pool.acquire} is called without an estimate.
   * Defaults to {@link DEFAULT_FALLBACK_BLOCK}.
   */
  readonly fallbackBlock?: number;
  /**
   * Milliseconds a Reservation's lease survives before it is auto-released on
   * the next access/Sync of its Account. Defaults to {@link DEFAULT_LEASE_TTL}.
   */
  readonly leaseTtl?: number;
  /**
   * Milliseconds a snapshot is trusted before {@link Pool.acquire} lazily
   * re-Syncs it. Defaults to {@link DEFAULT_STALENESS_TTL}.
   */
  readonly stalenessTtl?: number;
  /**
   * Fraction of Quota at or below which an Account's remaining Credits force a
   * blocking Sync before selection. Defaults to
   * {@link DEFAULT_NEAR_LIMIT_THRESHOLD}.
   */
  readonly nearLimitThreshold?: number;
  /**
   * Times a failed Sync is retried before the last-known snapshot is kept.
   * Defaults to {@link DEFAULT_SYNC_RETRIES}.
   */
  readonly syncRetries?: number;
  /**
   * Base backoff in milliseconds between Sync retries (doubles each attempt).
   * Defaults to {@link DEFAULT_SYNC_BACKOFF}.
   */
  readonly syncBackoff?: number;
  /**
   * Sleeps for the given milliseconds. Injected so tests can drive Sync-retry
   * backoff without real delays. Defaults to a `setTimeout`-based sleep.
   */
  readonly sleep?: (ms: number) => Promise<void>;
  /**
   * Id of an Account permitted to run into Overage once every other Account is
   * exhausted — an explicit opt-in to completion-at-a-cost. Held out of the
   * normal waterfall and used only as a last resort; omit to make exhaustion
   * throw {@link AllAccountsExhausted} instead. Must name a registered Account.
   */
  readonly overflowAccountId?: string;
}

/**
 * A collection of ElevenLabs Accounts that hands back the Key of an Account
 * which still has Quota, draining Accounts in Priority order (waterfall) so
 * prepaid Credits are used before any Overage risk.
 *
 * Construct one with {@link createPool}.
 */
export class Pool {
  /** Accounts ordered by Priority: lower number drained first. */
  readonly #accounts: readonly AccountConfig[];
  readonly #fetcher: SubscriptionFetcher;
  readonly #clock: Clock;
  readonly #storage: StorageAdapter;
  readonly #fallbackBlock: number;
  readonly #leaseTtl: number;
  readonly #stalenessTtl: number;
  readonly #nearLimitThreshold: number;
  readonly #syncRetries: number;
  readonly #syncBackoff: number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #overflowAccountId: string | undefined;

  /** Accounts by id, for {@link Pool.sync} of a single Account. */
  readonly #accountsById = new Map<string, AccountConfig>();

  /**
   * In-flight Syncs, keyed by Account id, so concurrent acquires (and explicit
   * Syncs) refresh each Account once rather than racing to fetch it N times.
   */
  readonly #syncing = new Map<string, Promise<boolean>>();

  /**
   * The `resetAt` last applied as a local Quota reset per Account, so a passed
   * reset snaps `remaining` back to full Quota exactly once — later commits in
   * the new period aren't erased by re-applying the same reset.
   */
  readonly #appliedResets = new Map<string, number>();

  constructor(config: PoolConfig) {
    if (config.accounts.length === 0) {
      throw new Error('A Pool needs at least one Account.');
    }
    const ids = new Set<string>();
    for (const account of config.accounts) {
      if (ids.has(account.id)) {
        throw new Error(`Duplicate Account id: ${account.id}`);
      }
      ids.add(account.id);
    }

    // Sort a copy so a higher-Priority (lower-numbered) Account drains first,
    // regardless of the order the caller registered them in.
    this.#accounts = [...config.accounts].sort((a, b) => a.priority - b.priority);
    for (const account of this.#accounts) {
      this.#accountsById.set(account.id, account);
    }
    this.#fetcher = config.fetcher ?? defaultFetcher;
    this.#clock = config.clock ?? Date.now;
    // Share the pool's clock with the default adapter so lease expiry advances
    // with the same injected time source (deterministic in tests).
    this.#storage = config.storage ?? new InMemoryStorageAdapter({ clock: this.#clock });
    this.#fallbackBlock = config.fallbackBlock ?? DEFAULT_FALLBACK_BLOCK;
    this.#leaseTtl = config.leaseTtl ?? DEFAULT_LEASE_TTL;
    this.#stalenessTtl = config.stalenessTtl ?? DEFAULT_STALENESS_TTL;
    this.#nearLimitThreshold = config.nearLimitThreshold ?? DEFAULT_NEAR_LIMIT_THRESHOLD;
    this.#syncRetries = config.syncRetries ?? DEFAULT_SYNC_RETRIES;
    this.#syncBackoff = config.syncBackoff ?? DEFAULT_SYNC_BACKOFF;
    this.#sleep = config.sleep ?? defaultSleep;

    if (config.overflowAccountId !== undefined && !this.#accountsById.has(config.overflowAccountId)) {
      throw new Error(`Unknown overflow Account id: ${config.overflowAccountId}`);
    }
    this.#overflowAccountId = config.overflowAccountId;
  }

  /**
   * Reserve Credits on the highest-Priority Account with room and return its
   * Key. Waterfalls to the next Account when one can't fit the reservation, so
   * overlapping callers never both grab the same near-full Account.
   *
   * @param estimatedCredits Credits the Generation is expected to consume. When
   *   omitted, the configured fallback block is reserved instead.
   * @returns a {@link KeyLease} carrying the selected Account's Key and the
   *   `commit`/`release` handles for its Reservation.
   * @throws {@link AllAccountsExhausted} when no Account has room and no
   *   overflow Account is configured.
   */
  async acquire(estimatedCredits?: number): Promise<KeyLease> {
    const credits = estimatedCredits ?? this.#fallbackBlock;

    for (const account of this.#accounts) {
      // The overflow Account is held out of the normal waterfall and used only
      // as a last resort (below), so prepaid Credits are spent first.
      if (account.id === this.#overflowAccountId) {
        continue;
      }
      // Refresh drift before selecting: seed on first use, apply a due Quota
      // reset, and lazily/forcibly Sync. A failed refresh keeps the last-known
      // snapshot; only an unseeded Account with a down fetcher is skipped.
      const snapshot = await this.#ensureFresh(account);
      if (!snapshot) {
        continue;
      }
      const reservation = await this.#storage.reserve(account.id, credits, this.#leaseTtl);
      if (reservation) {
        return this.#lease(account.key, reservation.id);
      }
    }

    // Every non-overflow Account is exhausted. Fall back to the overflow
    // Account if one is configured, letting it run into Overage.
    if (this.#overflowAccountId !== undefined) {
      const overflow = this.#accountsById.get(this.#overflowAccountId)!;
      const snapshot = await this.#ensureFresh(overflow);
      if (snapshot) {
        const reservation = await this.#storage.reserve(
          overflow.id,
          credits,
          this.#leaseTtl,
          true, // allow Overage: the overflow Account's explicit opt-in
        );
        if (reservation) {
          return this.#lease(overflow.key, reservation.id);
        }
      }
    }

    throw new AllAccountsExhausted(this.#accounts.map((account) => account.id));
  }

  /**
   * Refresh Accounts from ElevenLabs. Call at startup or from a cron to warm
   * snapshots ahead of the first {@link Pool.acquire}, keeping the acquire path
   * off the network.
   *
   * @param accountId Refresh just this Account; omit to refresh all. A failed
   *   Sync keeps the Account's last-known snapshot (best-effort), so this never
   *   throws for a fetch failure.
   * @throws if `accountId` names an Account the pool doesn't hold.
   */
  async sync(accountId?: string): Promise<void> {
    if (accountId !== undefined) {
      const account = this.#accountsById.get(accountId);
      if (!account) {
        throw new Error(`Unknown Account: ${accountId}`);
      }
      await this.#syncAccount(account);
      return;
    }
    await Promise.all(this.#accounts.map((account) => this.#syncAccount(account)));
  }

  /** Wrap a Reservation as a {@link KeyLease} bound to its commit/release. */
  #lease(key: string, reservationId: string): KeyLease {
    const storage = this.#storage;
    return {
      key,
      commit: (actualCredits) => storage.commit(reservationId, actualCredits),
      release: () => storage.release(reservationId),
    };
  }

  /**
   * Bring an Account's snapshot up to date before selection and return it (or
   * `undefined` if it has never been Synced and the seeding fetch failed).
   *
   * Order matters: seed a cold Account, then apply a due Quota reset locally,
   * then Sync if the snapshot is stale or the Account is near its limit.
   */
  async #ensureFresh(account: AccountConfig): Promise<AccountSnapshot | undefined> {
    let snapshot = await this.#storage.readSnapshot(account.id);
    if (!snapshot) {
      // Never Synced: seed it. A freshly seeded snapshot is by definition fresh,
      // so there's nothing more to refresh this pass.
      await this.#syncAccount(account);
      return this.#storage.readSnapshot(account.id);
    }

    snapshot = await this.#applyResetIfDue(account.id, snapshot);

    const now = this.#clock();
    const stale = now - snapshot.syncedAt >= this.#stalenessTtl;
    const nearLimit = snapshot.remaining <= snapshot.quota * this.#nearLimitThreshold;
    if (stale || nearLimit) {
      await this.#syncAccount(account);
      snapshot = (await this.#storage.readSnapshot(account.id)) ?? snapshot;
    }
    return snapshot;
  }

  /**
   * Snap an Account's local `remaining` back to full Quota when its billing
   * period has rolled over (`resetAt` has passed), applied at most once per
   * period so commits in the new period aren't erased. Local drift correction
   * only — a subsequent Sync replaces it with the true post-reset balance.
   */
  async #applyResetIfDue(
    accountId: string,
    snapshot: AccountSnapshot,
  ): Promise<AccountSnapshot> {
    const due = snapshot.resetAt !== 0 && this.#clock() >= snapshot.resetAt;
    if (!due || this.#appliedResets.get(accountId) === snapshot.resetAt) {
      return snapshot;
    }
    const reset: AccountSnapshot = { ...snapshot, remaining: snapshot.quota };
    await this.#storage.writeSnapshot(accountId, reset);
    this.#appliedResets.set(accountId, snapshot.resetAt);
    return reset;
  }

  /**
   * Sync one Account: fetch its live balance (with backoff retries) and write
   * the snapshot. Concurrent callers share one in-flight Sync per Account. On
   * total failure the last-known snapshot is kept and `false` is returned — a
   * failed refresh must never break selection.
   */
  async #syncAccount(account: AccountConfig): Promise<boolean> {
    const existing = this.#syncing.get(account.id);
    if (existing) {
      return existing;
    }
    const run = this.#doSync(account).finally(() => {
      this.#syncing.delete(account.id);
    });
    this.#syncing.set(account.id, run);
    return run;
  }

  async #doSync(account: AccountConfig): Promise<boolean> {
    try {
      const subscription = await this.#fetchWithRetry(account.key);
      await this.#storage.writeSnapshot(account.id, this.#toSnapshot(subscription));
      return true;
    } catch {
      // Keep the last-known snapshot; selection proceeds on stale-but-usable data.
      return false;
    }
  }

  /** Fetch a Subscription, retrying with exponential backoff on failure. */
  async #fetchWithRetry(key: string): Promise<Subscription> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.#fetcher(key);
      } catch (error) {
        if (attempt >= this.#syncRetries) {
          throw error;
        }
        await this.#sleep(this.#syncBackoff * 2 ** attempt);
      }
    }
  }

  /** Convert a raw {@link Subscription} into a stored {@link AccountSnapshot}. */
  #toSnapshot(subscription: Subscription): AccountSnapshot {
    return {
      quota: subscription.character_limit,
      remaining: subscription.character_limit - subscription.character_count,
      resetAt: subscription.next_character_count_reset_unix * 1000,
      syncedAt: this.#clock(),
    };
  }
}

/** Construct a {@link Pool} from its configuration. */
export function createPool(config: PoolConfig): Pool {
  return new Pool(config);
}

/**
 * Placeholder default fetcher. A real ElevenLabs fetcher is introduced with the
 * Sync work; until then, omitting `fetcher` and relying on the default throws
 * rather than silently doing nothing.
 */
const defaultFetcher: SubscriptionFetcher = () => {
  throw new Error(
    'No subscription fetcher configured. Pass `fetcher` to createPool(...).',
  );
};

/** Real-time sleep used for Sync-retry backoff unless {@link PoolConfig.sleep} overrides it. */
const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
