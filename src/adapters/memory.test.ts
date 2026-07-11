import { describe, expect, it } from 'vitest';
import { InMemoryStorageAdapter } from './memory.js';
import type { AccountSnapshot } from '../types.js';

/** A seeded snapshot with `remaining` Credits and sensible defaults for the rest. */
function snapshotWith(remaining: number, quota = remaining): AccountSnapshot {
  return { quota, remaining, resetAt: 0, syncedAt: 0 };
}

/** An adapter with one Account already seeded to `remaining` Credits. */
async function seededAdapter(accountId: string, remaining: number) {
  const adapter = new InMemoryStorageAdapter();
  await adapter.writeSnapshot(accountId, snapshotWith(remaining));
  return adapter;
}

/** The `remaining` Credits recorded in an Account's snapshot. */
async function remainingOf(adapter: InMemoryStorageAdapter, accountId: string) {
  return (await adapter.readSnapshot(accountId))?.remaining;
}

describe('InMemoryStorageAdapter', () => {
  it('round-trips a written snapshot', async () => {
    const adapter = new InMemoryStorageAdapter();
    const snapshot = snapshotWith(1000, 5000);

    await adapter.writeSnapshot('acct-a', snapshot);

    expect(await adapter.readSnapshot('acct-a')).toEqual(snapshot);
  });

  it('reports no snapshot and zero available Credits for an unknown Account', async () => {
    const adapter = new InMemoryStorageAdapter();

    expect(await adapter.readSnapshot('nope')).toBeUndefined();
    expect(await adapter.getAvailableCredits('nope')).toBe(0);
  });

  it('reports available Credits equal to remaining before any Reservation', async () => {
    const adapter = await seededAdapter('acct-a', 1000);

    expect(await adapter.getAvailableCredits('acct-a')).toBe(1000);
  });

  it('reduces available Credits by the amount reserved', async () => {
    const adapter = await seededAdapter('acct-a', 1000);

    const reservation = await adapter.reserve('acct-a', 300);

    expect(reservation).not.toBeNull();
    expect(reservation?.accountId).toBe('acct-a');
    expect(reservation?.credits).toBe(300);
    expect(await adapter.getAvailableCredits('acct-a')).toBe(700);
  });

  it('does not debit remaining until a Reservation is committed', async () => {
    const adapter = await seededAdapter('acct-a', 1000);

    await adapter.reserve('acct-a', 300);

    // remaining is the last-known true balance; a Reservation is only a hold.
    expect(await remainingOf(adapter, 'acct-a')).toBe(1000);
  });

  it('refuses a Reservation larger than available Credits, with no partial effect', async () => {
    const adapter = await seededAdapter('acct-a', 500);

    const reservation = await adapter.reserve('acct-a', 501);

    expect(reservation).toBeNull();
    expect(await adapter.getAvailableCredits('acct-a')).toBe(500);
  });

  it('lets a second Reservation consume exactly the remaining availability', async () => {
    const adapter = await seededAdapter('acct-a', 1000);

    await adapter.reserve('acct-a', 600);
    const second = await adapter.reserve('acct-a', 400);
    const third = await adapter.reserve('acct-a', 1);

    expect(second).not.toBeNull();
    expect(third).toBeNull();
    expect(await adapter.getAvailableCredits('acct-a')).toBe(0);
  });

  it('debits remaining by the actual Credits on commit and frees the hold', async () => {
    const adapter = await seededAdapter('acct-a', 1000);
    const reservation = await adapter.reserve('acct-a', 300);

    // Actual usage came back lower than the estimate.
    await adapter.commit(reservation!.id, 280);

    expect(await remainingOf(adapter, 'acct-a')).toBe(720);
    // Hold is gone: available reflects the new remaining, not remaining minus a hold.
    expect(await adapter.getAvailableCredits('acct-a')).toBe(720);
  });

  it('commits the actual amount even when it exceeds the estimate', async () => {
    const adapter = await seededAdapter('acct-a', 1000);
    const reservation = await adapter.reserve('acct-a', 300);

    await adapter.commit(reservation!.id, 340);

    expect(await remainingOf(adapter, 'acct-a')).toBe(660);
  });

  it('refunds a Reservation on release, leaving remaining untouched', async () => {
    const adapter = await seededAdapter('acct-a', 1000);
    const reservation = await adapter.reserve('acct-a', 300);

    await adapter.release(reservation!.id);

    expect(await remainingOf(adapter, 'acct-a')).toBe(1000);
    expect(await adapter.getAvailableCredits('acct-a')).toBe(1000);
  });

  it('tracks Reservations per Account independently', async () => {
    const adapter = new InMemoryStorageAdapter();
    await adapter.writeSnapshot('acct-a', snapshotWith(1000));
    await adapter.writeSnapshot('acct-b', snapshotWith(1000));

    await adapter.reserve('acct-a', 400);

    expect(await adapter.getAvailableCredits('acct-a')).toBe(600);
    expect(await adapter.getAvailableCredits('acct-b')).toBe(1000);
  });

  it('never over-reserves when many holds are taken concurrently', async () => {
    const adapter = await seededAdapter('acct-a', 1000);

    // 20 concurrent attempts of 100 Credits each against 1000 available.
    const results = await Promise.all(
      Array.from({ length: 20 }, () => adapter.reserve('acct-a', 100)),
    );

    const granted = results.filter((r) => r !== null);
    // Exactly 10 can be honoured; the rest must be refused.
    expect(granted).toHaveLength(10);
    expect(await adapter.getAvailableCredits('acct-a')).toBe(0);
  });

  it('rejects a negative Reservation', async () => {
    const adapter = await seededAdapter('acct-a', 1000);

    await expect(adapter.reserve('acct-a', -1)).rejects.toThrow();
  });

  it('throws when committing or releasing an unknown Reservation', async () => {
    const adapter = await seededAdapter('acct-a', 1000);

    await expect(adapter.commit('missing', 100)).rejects.toThrow();
    await expect(adapter.release('missing')).rejects.toThrow();
  });

  describe('lease expiry', () => {
    it('auto-releases an expired Reservation, restoring available Credits', async () => {
      let now = 1000;
      const adapter = new InMemoryStorageAdapter({ clock: () => now });
      await adapter.writeSnapshot('acct-a', snapshotWith(1000));

      await adapter.reserve('acct-a', 300, 5000); // leases until now + 5000
      expect(await adapter.getAvailableCredits('acct-a')).toBe(700);

      now += 5001; // advance past the lease
      expect(await adapter.getAvailableCredits('acct-a')).toBe(1000);
    });

    it('lets a fresh Reservation take the Credits an expired one freed', async () => {
      let now = 1000;
      const adapter = new InMemoryStorageAdapter({ clock: () => now });
      await adapter.writeSnapshot('acct-a', snapshotWith(1000));

      await adapter.reserve('acct-a', 1000, 5000); // holds everything
      now += 5001;

      // The expired hold is pruned before this reserve is measured, so it fits.
      expect(await adapter.reserve('acct-a', 1000, 5000)).not.toBeNull();
    });

    it('never expires a Reservation taken without a lease', async () => {
      let now = 1000;
      const adapter = new InMemoryStorageAdapter({ clock: () => now });
      await adapter.writeSnapshot('acct-a', snapshotWith(1000));

      await adapter.reserve('acct-a', 300); // no leaseMs -> never expires
      now += 1_000_000_000;

      expect(await adapter.getAvailableCredits('acct-a')).toBe(700);
    });

    it('leaves a Reservation committed before its lease elapsed unaffected by expiry', async () => {
      let now = 1000;
      const adapter = new InMemoryStorageAdapter({ clock: () => now });
      await adapter.writeSnapshot('acct-a', snapshotWith(1000));

      const reservation = await adapter.reserve('acct-a', 300, 5000);
      await adapter.commit(reservation!.id, 300); // committed before expiry
      now += 5001; // lease would have elapsed, but it's already reconciled

      // remaining reflects the committed 300, not a double-count or a refund.
      expect(await remainingOf(adapter, 'acct-a')).toBe(700);
      expect(await adapter.getAvailableCredits('acct-a')).toBe(700);
    });
  });
});
