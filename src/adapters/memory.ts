import { randomUUID } from 'node:crypto';
import type { AccountSnapshot, Reservation, StorageAdapter } from '../types.js';

/**
 * The default {@link StorageAdapter}: holds all state in process memory.
 *
 * Correct for a single long-lived process. Its atomic guarantee rests on
 * JavaScript's single-threaded execution — {@link reserve} performs its
 * check-and-hold synchronously, with no intervening `await`, so no two
 * `reserve` calls in the same process can interleave and double-spend an
 * Account. Serverless deployments with concurrent invocations need a
 * shared-store adapter instead (see ADR-0001).
 */
export class InMemoryStorageAdapter implements StorageAdapter {
  readonly #snapshots = new Map<string, AccountSnapshot>();
  readonly #reservations = new Map<string, Reservation>();

  async writeSnapshot(accountId: string, snapshot: AccountSnapshot): Promise<void> {
    this.#snapshots.set(accountId, snapshot);
  }

  async readSnapshot(accountId: string): Promise<AccountSnapshot | undefined> {
    return this.#snapshots.get(accountId);
  }

  async getAvailableCredits(accountId: string): Promise<number> {
    return this.#availableCredits(accountId);
  }

  async reserve(accountId: string, credits: number): Promise<Reservation | null> {
    if (credits < 0) {
      throw new Error(`Cannot reserve a negative number of Credits: ${credits}`);
    }
    // Synchronous from here to the return: atomic with respect to other reserves.
    if (this.#availableCredits(accountId) < credits) {
      return null;
    }
    const reservation: Reservation = { id: randomUUID(), accountId, credits };
    this.#reservations.set(reservation.id, reservation);
    return reservation;
  }

  async commit(reservationId: string, actualCredits: number): Promise<void> {
    const reservation = this.#requireReservation(reservationId);
    // Invariant: a Reservation can only be held against a seeded Account, and
    // snapshots are overwritten by Sync but never removed — so the snapshot is
    // always present here. Enforce it rather than silently dropping the debit.
    const snapshot = this.#snapshots.get(reservation.accountId);
    if (!snapshot) {
      throw new Error(
        `Cannot commit Reservation ${reservationId}: Account ${reservation.accountId} has no snapshot`,
      );
    }
    this.#snapshots.set(reservation.accountId, {
      ...snapshot,
      remaining: snapshot.remaining - actualCredits,
    });
    this.#reservations.delete(reservationId);
  }

  async release(reservationId: string): Promise<void> {
    this.#requireReservation(reservationId);
    this.#reservations.delete(reservationId);
  }

  /** `remaining` minus the sum of this Account's outstanding Reservations. */
  #availableCredits(accountId: string): number {
    const snapshot = this.#snapshots.get(accountId);
    if (!snapshot) {
      return 0;
    }
    let reserved = 0;
    for (const reservation of this.#reservations.values()) {
      if (reservation.accountId === accountId) {
        reserved += reservation.credits;
      }
    }
    return snapshot.remaining - reserved;
  }

  #requireReservation(reservationId: string): Reservation {
    const reservation = this.#reservations.get(reservationId);
    if (!reservation) {
      throw new Error(`Unknown Reservation: ${reservationId}`);
    }
    return reservation;
  }
}
