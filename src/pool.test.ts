import { describe, expect, it } from 'vitest';
import { createPool } from './pool.js';
import { AllAccountsExhausted, InvalidKeyError } from './errors.js';
import type { Subscription, SubscriptionFetcher } from './types.js';

/** An `Error` carrying an HTTP `status`, as a real HTTP client would surface a 401/403. */
function httpError(status: number): Error {
  return Object.assign(new Error(`HTTP ${status}`), { status });
}

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

/**
 * A fetcher that counts calls per Key and delegates to `impl` (which may throw
 * to simulate a failed Sync). Lets a test assert Sync/retry behaviour.
 */
function countingFetcher(impl: (key: string, call: number) => Subscription) {
  const calls: Record<string, number> = {};
  const fetcher: SubscriptionFetcher = async (key) => {
    calls[key] = (calls[key] ?? 0) + 1;
    return impl(key, calls[key]);
  };
  return { fetcher, calls };
}

/** A clock frozen at a fixed instant; enough for the seed/acquire path. */
const fixedClock = () => 1_000_000;

/** A no-op sleep so Sync-retry backoff doesn't add real delay in tests. */
const noSleep = async () => {};

describe('createPool acquire()', () => {
  it('returns the highest-Priority Account with room as a KeyLease', async () => {
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

    const lease = await pool.acquire(100);

    expect(lease.key).toBe('key-a');
    expect(typeof lease.commit).toBe('function');
    expect(typeof lease.release).toBe('function');
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
    expect((await pool.acquire(500)).key).toBe('key-b');
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
    expect((await pool.acquire(1000)).key).toBe('key-a');
    // a is now held to 0 available, so the next acquire waterfalls to b.
    expect((await pool.acquire(1)).key).toBe('key-b');
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
    expect((await pool.acquire()).key).toBe('key-a');
    expect((await pool.acquire()).key).toBe('key-b');
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

    expect([first.key, second.key].sort()).toEqual(['key-a', 'key-b']);
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

describe('createPool sync & drift correction', () => {
  it('re-Syncs a snapshot older than the staleness TTL before selecting', async () => {
    let now = 1_000_000;
    // 500 remaining on the first Sync, refilled to 900 on the next.
    const { fetcher, calls } = countingFetcher((_key, call) =>
      call === 1 ? sub(1000, 500) : sub(1000, 100),
    );
    const pool = createPool({
      accounts: [{ id: 'a', key: 'key-a', priority: 1 }],
      fetcher,
      clock: () => now,
      stalenessTtl: 60_000,
    });

    await pool.acquire(400); // seeds a: remaining 500, holds 400
    expect(calls['key-a']).toBe(1);

    now += 60_001; // snapshot is now stale
    await pool.acquire(600); // triggers a re-Sync to remaining 900 first

    // Re-Synced (call 2), and the fresh 900 remaining fit the 600 acquire.
    expect(calls['key-a']).toBe(2);
  });

  it('does not re-Sync a snapshot within the staleness TTL', async () => {
    let now = 1_000_000;
    const { fetcher, calls } = countingFetcher(() => sub(1000));
    const pool = createPool({
      accounts: [{ id: 'a', key: 'key-a', priority: 1 }],
      fetcher,
      clock: () => now,
      stalenessTtl: 60_000,
    });

    await pool.acquire(100);
    now += 59_999; // still fresh
    await pool.acquire(100);

    expect(calls['key-a']).toBe(1);
  });

  it('forces a Sync when an Account is near its limit, regardless of TTL', async () => {
    const { fetcher, calls } = countingFetcher(() => sub(1000, 950)); // remaining 50
    const pool = createPool({
      accounts: [{ id: 'a', key: 'key-a', priority: 1 }],
      fetcher,
      clock: fixedClock, // never stale
      nearLimitThreshold: 0.1, // near limit at <= 100 remaining
    });

    await pool.acquire(10); // seeds a: remaining 50 (near limit)
    await pool.acquire(10); // near limit forces a Sync despite a fresh snapshot

    expect(calls['key-a']).toBe(2);
  });

  it('resets local remaining to full Quota once the reset time has passed', async () => {
    let now = 1_000_000;
    // remaining 200, resets at unix second 2000 -> 2_000_000 ms.
    const { fetcher, calls } = countingFetcher(() => sub(1000, 800, 2000));
    const pool = createPool({
      accounts: [{ id: 'a', key: 'key-a', priority: 1 }],
      fetcher,
      clock: () => now,
      stalenessTtl: 10_000_000, // large, so only the reset (not staleness) fires
    });

    await pool.acquire(200); // seeds a: remaining 200, holds 200 -> 0 available
    now = 2_000_001; // billing period has rolled over

    // Local reset snaps remaining back to full 1000 with no extra fetch.
    expect((await pool.acquire(1000)).key).toBe('key-a');
    expect(calls['key-a']).toBe(1);
  });

  it('sync() warms snapshots explicitly, off the acquire path', async () => {
    const { fetcher, calls } = countingFetcher(() => sub(1000));
    const pool = createPool({
      accounts: [
        { id: 'a', key: 'key-a', priority: 1 },
        { id: 'b', key: 'key-b', priority: 2 },
      ],
      fetcher,
      clock: fixedClock,
    });

    await pool.sync(); // seeds both up front
    expect(calls['key-a']).toBe(1);
    expect(calls['key-b']).toBe(1);

    await pool.acquire(100); // served from the warm snapshot, no extra fetch
    expect(calls['key-a']).toBe(1);
  });

  it('keeps the last-known snapshot and retries with backoff when a Sync fails', async () => {
    let now = 1_000_000;
    // Succeeds on the seed, then always fails (network/5xx).
    const { fetcher, calls } = countingFetcher((_key, call) => {
      if (call === 1) return sub(1000, 0);
      throw new Error('network down');
    });
    const pool = createPool({
      accounts: [{ id: 'a', key: 'key-a', priority: 1 }],
      fetcher,
      clock: () => now,
      stalenessTtl: 60_000,
      syncRetries: 2,
      sleep: noSleep,
    });

    await pool.acquire(100); // seed succeeds (call 1)
    now += 60_001; // force a stale re-Sync that will fail

    // Selection still succeeds on the last-known snapshot despite the failure.
    expect((await pool.acquire(100)).key).toBe('key-a');
    // 1 seed + (1 initial + 2 retries) for the failed Sync = 4 attempts.
    expect(calls['key-a']).toBe(4);
  });

  it('skips an unseeded Account whose fetcher is down and waterfalls to a healthy one', async () => {
    const { fetcher } = countingFetcher((key, call) => {
      if (key === 'key-a') throw new Error(`a is down (attempt ${call})`);
      return sub(1000);
    });
    const pool = createPool({
      accounts: [
        { id: 'a', key: 'key-a', priority: 1 },
        { id: 'b', key: 'key-b', priority: 2 },
      ],
      fetcher,
      clock: fixedClock,
      syncRetries: 1,
      sleep: noSleep,
    });

    // a can't be seeded, so selection falls through to the healthy b.
    expect((await pool.acquire(100)).key).toBe('key-b');
  });
});

describe('createPool quarantine', () => {
  it('Quarantines an Account on a 401/403 during Sync and keeps serving healthy Accounts', async () => {
    const quarantined: string[] = [];
    const { fetcher, calls } = countingFetcher((key) => {
      if (key === 'key-a') throw httpError(401); // a's Key is revoked
      return sub(1000);
    });
    const pool = createPool({
      accounts: [
        { id: 'a', key: 'key-a', priority: 1 },
        { id: 'b', key: 'key-b', priority: 2 },
      ],
      fetcher,
      clock: fixedClock,
      sleep: noSleep,
      onQuarantine: (id) => quarantined.push(id),
    });

    // a can't be Synced (401), so it's Quarantined and selection serves b.
    expect((await pool.acquire(100)).key).toBe('key-b');
    expect(quarantined).toEqual(['a']);
    // An auth error is not retried, so a was fetched exactly once.
    expect(calls['key-a']).toBe(1);

    // a stays out of selection on the next acquire, with no further fetch.
    expect((await pool.acquire(100)).key).toBe('key-b');
    expect(calls['key-a']).toBe(1);
  });

  it('Quarantines an Account when the consumer reports the Key invalid via the lease', async () => {
    const quarantined: string[] = [];
    const { fetcher } = fakeFetcher({ 'key-a': sub(1000), 'key-b': sub(1000) });
    const pool = createPool({
      accounts: [
        { id: 'a', key: 'key-a', priority: 1 },
        { id: 'b', key: 'key-b', priority: 2 },
      ],
      fetcher,
      clock: fixedClock,
      onQuarantine: (id) => quarantined.push(id),
    });

    const lease = await pool.acquire(100); // key-a
    await lease.reportInvalid(); // consumer saw a 401 from the Generation call

    expect(quarantined).toEqual(['a']);
    // a is removed from selection; the pool serves the healthy b.
    expect((await pool.acquire(100)).key).toBe('key-b');
  });

  it('rejoins a Quarantined Account after a successful Sync', async () => {
    // a's Key fails auth on the first fetch, then works (a transient blip).
    const { fetcher } = countingFetcher((key, call) => {
      if (key === 'key-a' && call === 1) throw new InvalidKeyError();
      return sub(1000);
    });
    const pool = createPool({
      accounts: [
        { id: 'a', key: 'key-a', priority: 1 },
        { id: 'b', key: 'key-b', priority: 2 },
      ],
      fetcher,
      clock: fixedClock,
      sleep: noSleep,
    });

    expect((await pool.acquire(100)).key).toBe('key-b'); // a Quarantined

    await pool.sync('a'); // operator re-Syncs; this time it succeeds

    // a has rejoined selection and, being highest-Priority, is chosen again.
    expect((await pool.acquire(100)).key).toBe('key-a');
  });
});

describe('createPool exhaustion & overflow', () => {
  it('throws a typed AllAccountsExhausted when no Account has room and no overflow', async () => {
    const { fetcher } = fakeFetcher({ 'key-a': sub(100) });
    const pool = createPool({
      accounts: [{ id: 'a', key: 'key-a', priority: 1 }],
      fetcher,
      clock: fixedClock,
    });

    await expect(pool.acquire(200)).rejects.toBeInstanceOf(AllAccountsExhausted);
  });

  it('returns the overflow Account once all others are exhausted, even into Overage', async () => {
    const { fetcher } = fakeFetcher({ 'key-a': sub(100), 'key-b': sub(100) });
    const pool = createPool({
      accounts: [
        { id: 'a', key: 'key-a', priority: 1 },
        { id: 'b', key: 'key-b', priority: 2 },
      ],
      fetcher,
      clock: fixedClock,
      overflowAccountId: 'b',
    });

    expect((await pool.acquire(100)).key).toBe('key-a'); // drains a
    expect((await pool.acquire(100)).key).toBe('key-b'); // overflow, b now at 0
    // b has no room left, but as the overflow Account it's still handed out.
    expect((await pool.acquire(100)).key).toBe('key-b');
  });

  it('uses the overflow Account only after every non-overflow Account is exhausted', async () => {
    // b is the overflow Account and has the most room, but it's held last.
    const { fetcher } = fakeFetcher({
      'key-a': sub(100),
      'key-b': sub(1000),
      'key-c': sub(100),
    });
    const pool = createPool({
      accounts: [
        { id: 'a', key: 'key-a', priority: 1 },
        { id: 'b', key: 'key-b', priority: 2 },
        { id: 'c', key: 'key-c', priority: 3 },
      ],
      fetcher,
      clock: fixedClock,
      overflowAccountId: 'b',
    });

    expect((await pool.acquire(100)).key).toBe('key-a');
    // Skips overflow b despite its room; waterfalls to c.
    expect((await pool.acquire(100)).key).toBe('key-c');
    // a and c now exhausted, so the overflow Account is finally used.
    expect((await pool.acquire(100)).key).toBe('key-b');
  });

  it('rejects a pool whose overflowAccountId names no registered Account', () => {
    const { fetcher } = fakeFetcher({ 'key-a': sub(100) });
    expect(() =>
      createPool({
        accounts: [{ id: 'a', key: 'key-a', priority: 1 }],
        fetcher,
        clock: fixedClock,
        overflowAccountId: 'nope',
      }),
    ).toThrow(/overflow/i);
  });
});

describe('createPool lease expiry', () => {
  it('auto-releases an orphaned Reservation once its lease elapses', async () => {
    let now = 1_000_000;
    const { fetcher } = fakeFetcher({ 'key-a': sub(1000) });
    const pool = createPool({
      accounts: [{ id: 'a', key: 'key-a', priority: 1 }],
      fetcher,
      clock: () => now,
      leaseTtl: 30_000,
    });

    // Acquire holds all of a's Credits, then the caller "crashes" — no
    // commit, no release.
    await pool.acquire(1000);
    now += 30_001; // advance past the lease TTL

    // The orphaned hold is auto-released on the next acquire, so a fresh
    // 1000-Credit acquire succeeds on the same Account.
    expect((await pool.acquire(1000)).key).toBe('key-a');
  });

  it('does not release a Reservation before its lease elapses', async () => {
    let now = 1_000_000;
    const { fetcher } = fakeFetcher({ 'key-a': sub(1000), 'key-b': sub(1000) });
    const pool = createPool({
      accounts: [
        { id: 'a', key: 'key-a', priority: 1 },
        { id: 'b', key: 'key-b', priority: 2 },
      ],
      fetcher,
      clock: () => now,
      leaseTtl: 30_000,
    });

    await pool.acquire(1000); // holds all of a
    now += 29_999; // still within the lease

    // a is still fully held, so this acquire waterfalls to b.
    expect((await pool.acquire(1)).key).toBe('key-b');
  });
});

describe('createPool commit() / release()', () => {
  it('debits the actual Credits on commit, not the estimate, when actual is lower', async () => {
    const { fetcher } = fakeFetcher({ 'key-a': sub(1000), 'key-b': sub(1000) });
    const pool = createPool({
      accounts: [
        { id: 'a', key: 'key-a', priority: 1 },
        { id: 'b', key: 'key-b', priority: 2 },
      ],
      fetcher,
      clock: fixedClock,
    });

    const lease = await pool.acquire(1000); // holds all of a's Credits
    await lease.commit(300); // the Generation actually cost 300

    // a's remaining is now 700 (not 0): the estimate's hold was reconciled down.
    expect((await pool.acquire(700)).key).toBe('key-a');
  });

  it('debits the actual Credits on commit when actual exceeds the estimate', async () => {
    const { fetcher } = fakeFetcher({ 'key-a': sub(1000), 'key-b': sub(1000) });
    const pool = createPool({
      accounts: [
        { id: 'a', key: 'key-a', priority: 1 },
        { id: 'b', key: 'key-b', priority: 2 },
      ],
      fetcher,
      clock: fixedClock,
    });

    const lease = await pool.acquire(300); // holds 300
    await lease.commit(400); // the Generation actually cost 400

    // a's remaining is now 600, so a 700-Credit acquire waterfalls to b —
    // proving the true 400 was debited, not the 300 estimate.
    expect((await pool.acquire(700)).key).toBe('key-b');
  });

  it('refunds a Reservation in full on release, restoring availability', async () => {
    const { fetcher } = fakeFetcher({ 'key-a': sub(1000) });
    const pool = createPool({
      accounts: [{ id: 'a', key: 'key-a', priority: 1 }],
      fetcher,
      clock: fixedClock,
    });

    const lease = await pool.acquire(1000); // holds all of a's Credits
    await lease.release(); // the Generation failed; ElevenLabs charged nothing

    // The full 1000 is available again.
    expect((await pool.acquire(1000)).key).toBe('key-a');
  });

  it('computes availability as remaining minus committed minus live Reservations', async () => {
    const { fetcher } = fakeFetcher({ 'key-a': sub(1000), 'key-b': sub(1000) });
    const pool = createPool({
      accounts: [
        { id: 'a', key: 'key-a', priority: 1 },
        { id: 'b', key: 'key-b', priority: 2 },
      ],
      fetcher,
      clock: fixedClock,
    });

    const first = await pool.acquire(200);
    await first.commit(150); // a's remaining: 1000 - 150 = 850
    await pool.acquire(300); // a live Reservation of 300 -> available 550

    // 550 fits a exactly; the next Credit waterfalls to b.
    expect((await pool.acquire(550)).key).toBe('key-a');
    expect((await pool.acquire(1)).key).toBe('key-b');
  });
});
