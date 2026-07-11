import { describe, expect, it } from 'vitest';
import { createPool } from './pool.js';
import type { Subscription, SubscriptionFetcher } from './types.js';

/** A Subscription with `limit` Credits, `used` already spent, and a reset time. */
function sub(limit: number, used = 0, resetUnixSeconds = 0): Subscription {
  return {
    character_limit: limit,
    character_count: used,
    next_character_count_reset_unix: resetUnixSeconds,
  };
}

/**
 * A fetcher backed by a fixed key→Subscription map, counting calls per Key so a
 * test can assert the pool doesn't Sync on every acquire (user story 3).
 */
function fakeFetcher(byKey: Record<string, Subscription>) {
  const calls: Record<string, number> = {};
  const fetcher: SubscriptionFetcher = async (key) => {
    calls[key] = (calls[key] ?? 0) + 1;
    const subscription = byKey[key];
    if (!subscription) {
      throw new Error(`no Subscription registered for key ${key}`);
    }
    return subscription;
  };
  return { fetcher, calls };
}

/** A clock frozen at a fixed instant; enough for the seed/acquire path. */
const fixedClock = () => 1_000_000;

describe('createPool acquire()', () => {
  it('returns the highest-Priority Account with room as a bare Key string', async () => {
    const { fetcher } = fakeFetcher({
      'key-a': sub(1000),
      'key-b': sub(1000),
    });
    const pool = createPool({
      accounts: [
        { id: 'b', key: 'key-b', priority: 2 },
        { id: 'a', key: 'key-a', priority: 1 },
      ],
      fetcher,
      clock: fixedClock,
    });

    const key = await pool.acquire(100);

    expect(key).toBe('key-a');
    expect(typeof key).toBe('string');
  });

  it('seeds each Account from the fetcher on first use, so a drained Account is skipped', async () => {
    // Account a is registered highest-Priority but is fully consumed (used == limit).
    const { fetcher } = fakeFetcher({
      'key-a': sub(1000, 1000),
      'key-b': sub(1000, 0),
    });
    const pool = createPool({
      accounts: [
        { id: 'a', key: 'key-a', priority: 1 },
        { id: 'b', key: 'key-b', priority: 2 },
      ],
      fetcher,
      clock: fixedClock,
    });

    // a has no remaining Credits once seeded, so selection falls through to b.
    expect(await pool.acquire(500)).toBe('key-b');
  });

  it('drains a higher-Priority Account to its Quota before selecting the next (waterfall)', async () => {
    const { fetcher } = fakeFetcher({
      'key-a': sub(1000),
      'key-b': sub(1000),
    });
    const pool = createPool({
      accounts: [
        { id: 'a', key: 'key-a', priority: 1 },
        { id: 'b', key: 'key-b', priority: 2 },
      ],
      fetcher,
      clock: fixedClock,
    });

    // First acquire reserves all of a's Credits.
    expect(await pool.acquire(1000)).toBe('key-a');
    // a is now held to 0 available, so the next acquire waterfalls to b.
    expect(await pool.acquire(1)).toBe('key-b');
  });

  it('reserves the configured fallback block when no estimate is given', async () => {
    const { fetcher } = fakeFetcher({
      'key-a': sub(500),
      'key-b': sub(1000),
    });
    const pool = createPool({
      accounts: [
        { id: 'a', key: 'key-a', priority: 1 },
        { id: 'b', key: 'key-b', priority: 2 },
      ],
      fetcher,
      clock: fixedClock,
      fallbackBlock: 500,
    });

    // a fits exactly one fallback block; the second estimate-less acquire waterfalls.
    expect(await pool.acquire()).toBe('key-a');
    expect(await pool.acquire()).toBe('key-b');
  });

  it('never lets two overlapping acquires double-spend the same near-full Account', async () => {
    const { fetcher } = fakeFetcher({
      'key-a': sub(1000),
      'key-b': sub(1000),
    });
    const pool = createPool({
      accounts: [
        { id: 'a', key: 'key-a', priority: 1 },
        { id: 'b', key: 'key-b', priority: 2 },
      ],
      fetcher,
      clock: fixedClock,
    });

    // Two overlapping 600-Credit acquires against a's 1000: only one fits a.
    const [first, second] = await Promise.all([pool.acquire(600), pool.acquire(600)]);

    expect([first, second].sort()).toEqual(['key-a', 'key-b']);
  });

  it('does not re-Sync an already-seeded Account on every acquire', async () => {
    const { fetcher, calls } = fakeFetcher({ 'key-a': sub(1000) });
    const pool = createPool({
      accounts: [{ id: 'a', key: 'key-a', priority: 1 }],
      fetcher,
      clock: fixedClock,
    });

    await pool.acquire(100);
    await pool.acquire(100);

    // Seeded once on first use; selection thereafter is local (no network per Generation).
    expect(calls['key-a']).toBe(1);
  });

  it('seeds each Account exactly once even under concurrent cold-start acquires', async () => {
    const { fetcher, calls } = fakeFetcher({ 'key-a': sub(1000) });
    const pool = createPool({
      accounts: [{ id: 'a', key: 'key-a', priority: 1 }],
      fetcher,
      clock: fixedClock,
    });

    await Promise.all([pool.acquire(100), pool.acquire(100)]);

    expect(calls['key-a']).toBe(1);
  });

  it('rejects a pool constructed with duplicate Account ids', () => {
    const { fetcher } = fakeFetcher({});
    expect(() =>
      createPool({
        accounts: [
          { id: 'a', key: 'key-a', priority: 1 },
          { id: 'a', key: 'key-a2', priority: 2 },
        ],
        fetcher,
        clock: fixedClock,
      }),
    ).toThrow(/duplicate/i);
  });
});
