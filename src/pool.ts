import { InMemoryStorageAdapter } from './adapters/memory.js';
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

  /**
   * In-flight seeds, keyed by Account id, so concurrent cold-start acquires
   * Sync each Account once rather than racing to fetch it N times.
   */
  readonly #seeding = new Map<string, Promise<void>>();

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
    this.#fetcher = config.fetcher ?? defaultFetcher;
    this.#clock = config.clock ?? Date.now;
    this.#storage = config.storage ?? new InMemoryStorageAdapter();
    this.#fallbackBlock = config.fallbackBlock ?? DEFAULT_FALLBACK_BLOCK;
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
   * @throws if no Account has room for the reservation.
   */
  async acquire(estimatedCredits?: number): Promise<KeyLease> {
    const credits = estimatedCredits ?? this.#fallbackBlock;

    for (const account of this.#accounts) {
      await this.#ensureSeeded(account);
      const reservation = await this.#storage.reserve(account.id, credits);
      if (reservation) {
        return this.#lease(account.key, reservation.id);
      }
    }

    // Typed exhaustion + optional overflow Account are a later concern (#7).
    throw new Error('No Account has enough Credits available to acquire a Key.');
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
   * Seed an Account's snapshot from a first Sync when it has never been Synced.
   * Concurrent callers share one in-flight fetch per Account.
   */
  async #ensureSeeded(account: AccountConfig): Promise<void> {
    if (await this.#storage.readSnapshot(account.id)) {
      return;
    }
    const existing = this.#seeding.get(account.id);
    if (existing) {
      return existing;
    }
    const seed = this.#seed(account).finally(() => {
      this.#seeding.delete(account.id);
    });
    this.#seeding.set(account.id, seed);
    return seed;
  }

  async #seed(account: AccountConfig): Promise<void> {
    const subscription = await this.#fetcher(account.key);
    await this.#storage.writeSnapshot(account.id, this.#toSnapshot(subscription));
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
