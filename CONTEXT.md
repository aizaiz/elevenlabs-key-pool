# ElevenLabs Key Pool

A module that spreads ElevenLabs usage across multiple subscription accounts, handing back an API key from an account that still has quota — so you avoid paying overage rates by exhausting one account before falling back to the next.

## Language

**Account**:
An ElevenLabs subscription that owns a Quota, a reset time, and one API key. The pool's internal unit of tracking, because quota belongs to the account, not the key.
_Avoid_: Subscription, key (as the unit of tracking)

**Key**:
The API credential belonging to an Account, handed to the consumer to authenticate a Generation. Just the thing you hand out — never the unit of quota.
_Avoid_: Token, credential

**KeyLease**:
What `acquire()` hands back: the selected Account's Key together with the handles that close out the Reservation taken for it — `commit(actualCredits)`, `release()`, and `reportInvalid()`. The Key alone can't reference its Reservation safely when concurrent callers hold different Reservations on the same Account, so the lease binds the two. Read `.key` for the ElevenLabs client. (Supersedes the earlier "acquire returns a bare Key string" intent; see ADR-0002.)
_Avoid_: Ticket, handle, token

**Credit**:
The unit of ElevenLabs quota. Cost per input character depends on the model: standard models (v1/v2 multilingual) = 1 credit/char; Flash/Turbo = 0.5 credits/char. Formerly called "characters" (same value, renamed). The Get User Subscription endpoint still exposes credits under legacy `character_*` field names — read those, but treat the values as credits.
_Avoid_: Character (as the balance unit)

**Quota**:
An Account's Credit allowance for the current billing period — i.e. its `character_limit`, which the pool treats as the ceiling to stay under so it never tips into overage.
_Avoid_: Limit, allowance, characters

**Usage**:
The Credits a Generation consumed, reconciled back to the pool by the consumer so the Account's remaining Quota can be debited accurately.
_Avoid_: Spend, consumption, cost

**Generation**:
A single ElevenLabs API call that consumes Credits against a Quota (e.g. text-to-speech). Credits are debited only on success; a failed Generation consumes nothing.
_Avoid_: Request, call, synthesis

**Overage**:
Charges incurred when an Account's Usage exceeds its Quota. The condition the pool exists to avoid — it stops handing out an Account's Key once that Account reaches its limit.
_Avoid_: Overuse, excess billing

**Priority**:
The configured order in which the pool drains Accounts. It fills a higher-priority Account up to its Quota before selecting the next (waterfall selection), so prepaid Credits are fully used before any Overage risk.
_Avoid_: Weight, rank

**Reservation**:
A provisional hold on an Account's Credits taken when a Key is acquired, so concurrent callers can't double-spend the same Account. Reconciled to actual Usage on commit, refunded on release, and auto-refunded when its lease expires if neither happens.
_Avoid_: Hold, lock, allocation

**Sync**:
Refreshing an Account's true Quota and remaining balance from the ElevenLabs Get User Subscription endpoint — correcting local drift and applying Quota resets. Triggered lazily when a snapshot is stale, forced when an Account nears its limit, or invoked explicitly.
_Avoid_: Refresh, poll, reconcile

**Quarantine**:
The state of an Account temporarily removed from selection because its Key is invalid/revoked. The pool keeps serving from healthy Accounts and notifies the operator; a quarantined Account can rejoin after a successful Sync.
_Avoid_: Disable, ban

**Pool**:
The collection of Accounts. Selects an Account that still has Quota and returns its Key; debits the Account when Usage is reported.
_Avoid_: Manager, registry
