# elevenlabs-key-pool

Spread ElevenLabs usage across several subscription Accounts and, on demand, hand back the API Key of an Account that **still has quota** — draining Accounts in a configured priority order so prepaid Credits are fully used before any overage risk.

A thin, dependency-free TypeScript library. It does **not** wrap ElevenLabs' generation API — you keep making your own calls; the pool just tells you which Key to use and tracks the spend.

---

## Why

ElevenLabs bills **overage** (usage past a plan's included Credits) at a higher per-Credit rate than the Credits bundled into a plan. Once you're regularly exhausting one subscription, owning two or three cheaper subscriptions and spreading usage across them is cheaper than paying overage on one — but doing that by hand is impractical:

- You'd have to know which Account still has quota **before every generation**.
- Checking ElevenLabs' subscription endpoint before each call adds a network round trip that makes key selection slow.

This library solves both: it tracks each Account's remaining Credits **locally** (fast, no per-generation network call), drains Accounts in priority order (**waterfall**), and only re-syncs with ElevenLabs periodically to correct drift.

## When to use it

**Use it when** you run credit-consuming ElevenLabs features (TTS, STT, sound effects, music, voice changer/isolator, dubbing) across **multiple subscriptions** and want to exhaust cheap prepaid Credits before touching a more expensive one — in a long-lived process **or** serverless (Next.js, Lambda, Workers).

**It is not for** (v1 out of scope):

- **Open-ended Conversational AI sessions** — their cost can't be bounded up front, so they don't fit the reserve-then-reconcile model.
- **Wrapping generations** — the pool never calls the generation API, computes per-model costs, or reads the `x-character-count` header itself. You do, and you report the cost back.
- **Shipping Redis/Upstash/KV adapters** — v1 defines the storage interface and ships an in-memory default; a shared-store adapter is yours to provide (see [Serverless](#serverless--shared-storage)).
- **Rate-limit handling / load balancing** — selection optimizes for cost (waterfall), not latency or 429 handling.

---

## Install

```bash
npm install @aizaiz/elevenlabs-key-pool
```

ESM-only, Node ≥ 18.

---

## Quick start

```ts
import {
  createPool,
  InvalidKeyError,
  isAuthError,
  type SubscriptionFetcher,
} from '@aizaiz/elevenlabs-key-pool';

// 1. Teach the pool how to read an Account's balance. The pool only ever calls
//    ElevenLabs' Get User Subscription endpoint — never the generation API.
const fetcher: SubscriptionFetcher = async (key) => {
  const res = await fetch('https://api.elevenlabs.io/v1/user/subscription', {
    headers: { 'xi-api-key': key },
  });
  if (res.status === 401 || res.status === 403) {
    // Surface auth failures so the pool can Quarantine this Account (see below).
    throw new InvalidKeyError('ElevenLabs rejected the Key', res.status);
  }
  if (!res.ok) throw new Error(`subscription fetch failed: ${res.status}`);
  return res.json(); // { character_count, character_limit, next_character_count_reset_unix, ... }
};

// 2. Register your Accounts in priority order (lower number drains first).
const pool = createPool({
  accounts: [
    { id: 'primary', key: process.env.ELEVENLABS_KEY_1!, priority: 1 },
    { id: 'secondary', key: process.env.ELEVENLABS_KEY_2!, priority: 2 },
  ],
  fetcher,
});

// 3. Acquire a Key, use it, then reconcile the spend.
const estimatedCredits = text.length; // good enough to hold the Account safely
const lease = await pool.acquire(estimatedCredits);

try {
  const res = await callElevenLabsTextToSpeech(lease.key, text);

  // ElevenLabs reports the true cost in a response header; you pass it back.
  const actual = Number(res.headers.get('x-character-count'));
  await lease.commit(actual);
} catch (err) {
  if (isAuthError(err)) {
    await lease.reportInvalid(); // 401/403 → Quarantine + refund the hold
  } else {
    await lease.release(); // generation failed → ElevenLabs charged nothing
  }
}
```

> **Header name:** confirm `x-character-count` against the live ElevenLabs API for your account/models — the reconciliation design doesn't otherwise depend on the exact name.

---

## How it works

### The acquire → commit → release lifecycle

`acquire()` **atomically reserves** Credits on the highest-priority Account with room and returns a **`KeyLease`**. That reservation is what keeps two overlapping callers from both grabbing the same near-full Account and tipping it into overage. You then close the reservation out:

| Method | When | Effect |
|--------|------|--------|
| `lease.key` | always | The bare API Key — pass it straight to your ElevenLabs client. |
| `lease.commit(actualCredits)` | generation succeeded | Reconciles the hold to the **true** cost (higher or lower than the estimate). |
| `lease.release()` | generation failed | Refunds the hold in full — ElevenLabs charges nothing on failure. |
| `lease.reportInvalid()` | you got a 401/403 | Refunds the hold **and** Quarantines the Account. |

> **Why a `KeyLease` and not a bare string?** Under concurrency, two `acquire()`s on the same Account share a Key but hold *distinct* reservations — a bare string couldn't say which one to reconcile. The lease binds Key → reservation. See [`docs/adr/0002`](docs/adr/0002-reserve-commit-release-credit-accounting.md).

**The estimate is optional.** Omit it and the pool reserves a configurable `fallbackBlock` instead, so concurrent selection stays safe even for features where you can't compute the cost up front:

```ts
const lease = await pool.acquire(); // reserves fallbackBlock (default 1000)
```

### Waterfall selection

Accounts drain in priority order: the pool fills `priority: 1` to its quota, then moves to `priority: 2`, and so on. This confines any overage risk to the last Account and uses prepaid Credits first.

### Sync & drift correction

Balances are tracked locally and re-synced only to correct drift — **no background timers** (safe for serverless). On `acquire()` the pool:

- **Seeds** an Account's quota/remaining on first use.
- **Lazily re-syncs** a snapshot older than `stalenessTtl`.
- **Forces a blocking sync** when an Account is **near its limit** (`nearLimitThreshold`), where stale data would risk an overage.
- **Resets** an Account's local counter to full quota once its `next_character_count_reset_unix` has passed.
- **Degrades gracefully** on a failed sync (5xx / network / 429): keeps the last-known snapshot and retries with backoff — a failed refresh never breaks selection. An **auth** failure (401/403) instead Quarantines.

Call `sync()` explicitly to warm balances at startup or from a cron:

```ts
await pool.sync();            // refresh all Accounts
await pool.sync('secondary'); // refresh one
```

### Exhaustion & the overflow Account

When no Account has room, `acquire()` throws a typed error rather than silently proceeding into overage:

```ts
import { AllAccountsExhausted } from '@aizaiz/elevenlabs-key-pool';

try {
  const lease = await pool.acquire(500);
} catch (err) {
  if (err instanceof AllAccountsExhausted) {
    // err.accountIds — every Account was out of room
  }
}
```

To opt into completion-at-a-cost, designate **one overflow Account** allowed to run into overage once every other Account is dry. It's held out of the normal waterfall and used only as a last resort:

```ts
const pool = createPool({
  accounts: [...],
  fetcher,
  overflowAccountId: 'secondary',
});
```

### Quarantine of bad Keys

A 401/403 — surfaced by you via `lease.reportInvalid()`, or hit during a sync — **Quarantines** the Account: it's removed from selection while the rest of the pool keeps serving, and a callback fires so you can fix or replace the Key. A subsequent **successful sync** lets it rejoin, so a transient auth blip doesn't permanently cost you an Account.

```ts
const pool = createPool({
  accounts: [...],
  fetcher,
  onQuarantine: (accountId) => alertOps(`Key for ${accountId} is invalid`),
});

// later, after you've fixed the Key upstream:
await pool.sync('primary'); // a successful sync rejoins it
```

---

## Configuration

`createPool(config)` — `accounts` and `fetcher` are the essentials; everything else has a sensible default.

| Option | Type | Default | Purpose |
|--------|------|---------|---------|
| `accounts` | `AccountConfig[]` | — (required) | `{ id, key, priority }` per Account. At least one; ids must be unique. |
| `fetcher` | `SubscriptionFetcher` | throws if unset | Reads an Account's balance from ElevenLabs. |
| `fallbackBlock` | `number` | `1000` | Credits reserved when `acquire()` is called without an estimate. |
| `leaseTtl` | `number` (ms) | `60_000` | How long a reservation survives before it's auto-released (a crashed caller can't strand Credits). |
| `stalenessTtl` | `number` (ms) | `300_000` | How long a snapshot is trusted before a lazy re-sync. |
| `nearLimitThreshold` | `number` (0–1) | `0.1` | Fraction of quota at/below which remaining Credits force a blocking sync. |
| `syncRetries` | `number` | `3` | Retries after a failed sync before keeping the last-known snapshot. |
| `syncBackoff` | `number` (ms) | `200` | Base backoff between sync retries (doubles each attempt). |
| `overflowAccountId` | `string` | none | Account permitted into overage once all others are exhausted. |
| `onQuarantine` | `(accountId) => void` | none | Fires when an Account is Quarantined. |
| `storage` | `StorageAdapter` | in-memory | Where balances/reservations live (see below). |
| `clock` | `() => number` | `Date.now` | Injected time source (for tests). |
| `sleep` | `(ms) => Promise<void>` | `setTimeout` | Injected sleep for sync backoff (for tests). |

The defaults are also exported as constants (`DEFAULT_FALLBACK_BLOCK`, `DEFAULT_LEASE_TTL`, `DEFAULT_STALENESS_TTL`, `DEFAULT_NEAR_LIMIT_THRESHOLD`, `DEFAULT_SYNC_RETRIES`, `DEFAULT_SYNC_BACKOFF`).

---

## Serverless & shared storage

State lives behind a small `StorageAdapter` interface (atomic reserve / commit / release + snapshot read/write). The default `InMemoryStorageAdapter` is correct for a **single long-lived process**.

For **serverless with concurrent invocations**, in-memory isn't enough — each invocation would hold a stale copy and could overspend an Account. Supply a shared-store adapter (Redis/Upstash/KV) that implements `StorageAdapter` with **atomic** reserve/commit so all invocations share one authoritative set of counters. Pool logic is identical across adapters.

```ts
import { createPool, type StorageAdapter } from '@aizaiz/elevenlabs-key-pool';

class RedisStorageAdapter implements StorageAdapter { /* ... */ }

const pool = createPool({ accounts, fetcher, storage: new RedisStorageAdapter() });
```

---

## Testing your integration

The pool takes its two side-effecting dependencies — the **subscription fetcher** and the **clock** — as injected seams, each with a real default. Substitute fakes to drive selection, sync, resets, and lease expiry deterministically with no network or real timers:

```ts
let now = 1_000_000;
const pool = createPool({
  accounts: [{ id: 'a', key: 'key-a', priority: 1 }],
  fetcher: async () => ({ character_count: 0, character_limit: 1000, next_character_count_reset_unix: 0 }),
  clock: () => now,
});

const lease = await pool.acquire(300);
await lease.commit(280);
now += 60_001; // advance past a lease TTL / staleness boundary — no real waiting
```

Tests use the real in-memory adapter (including for concurrency checks that fire overlapping `acquire()`s) and assert **external behavior** through the public API.

---

## Vocabulary

The domain terms used here (**Account**, **Credit**, **Quota**, **Reservation**, **Sync**, **Quarantine**, **Overage**, **KeyLease**, …) are defined precisely in [`CONTEXT.md`](CONTEXT.md). Design rationale lives in [`docs/adr/`](docs/adr/).

Key facts worth internalizing:

- **The unit is the Account, not the Key.** Quota belongs to the subscription; multiple Keys on one Account share one balance.
- **The unit is Credits, not characters.** ElevenLabs renamed "characters" to "credits" (same value) but still exposes them under legacy `character_*` field names. The pool reads those fields and treats them as Credits — correct across models that cost 0.5 vs 1 Credit per character.

---

## License

MIT
