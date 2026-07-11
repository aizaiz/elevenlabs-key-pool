# Reserve → commit → release credit accounting

Quota is debited with a three-step lifecycle: `acquire(estimatedCredits?)` atomically reserves credits and returns a **`KeyLease`** carrying the selected Account's Key plus the handles to close out that reservation — `commit(actualCredits)` reconciles it to the true cost; `release()` refunds it if the Generation failed. This is the only model that is both **concurrency-safe** (the atomic reserve stops two overlapping callers from both grabbing the same near-full Account and tipping it into overage) and **accurate**.

Key facts that shaped it:

- **`acquire()` returns a `KeyLease` handle, not a bare Key string.** The spec's user story 28 asked for a bare string, but that cannot coexist with per-reservation `commit`/`release` under concurrency: two overlapping `acquire()`s on the same Account yield the same Key but two *distinct* reservations, so a bare string can't say *which* reservation to reconcile. The `KeyLease` binds each Key to its own reservation — the caller reads `lease.key` for the ElevenLabs client and calls `lease.commit()` / `lease.release()` (and `lease.reportInvalid()` on a 401/403) to close it out. This supersedes story 28.

- **The unit is credits, not characters.** ElevenLabs renamed "characters" to "credits" (same value). The Get User Subscription endpoint still exposes the balance under legacy `character_*` field names (`character_count`, `character_limit`, `next_character_count_reset_unix`) — we read those but treat the values as credits.
- **The tracked unit is the Account, not the Key**, because quota belongs to the subscription; multiple keys on one account share one balance.
- **Exact cost is readable after the call.** ElevenLabs returns consumption in the `x-character-count` response header, so `commit()` can true up to the exact value — the up-front estimate only needs to be good enough to hold the Account atomically, not accurate.
- **The estimate is optional.** For the six bounded features (TTS, STT, sound effects, music, voice changer/isolator, dubbing) the caller can compute it from a known formula, but when omitted the pool reserves a configurable fallback block (default > 0 for safety; set to 0 to opt into report-after semantics). Credits are only charged by ElevenLabs on success, so `release()` on failure keeps our local count honest.

**Out of scope for v1:** open-ended Conversational AI sessions, whose cost cannot be bounded up front. They need a metered-reservation pattern (reserve a budget block, meter down, refund the remainder), which we defer.
