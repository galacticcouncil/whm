# Dutch Auction — price discovery without an oracle

The router signs a `token_diff`, and a `token_diff` is an **exact ratio**. Whoever fills in
`amount_out` sets the execution price, and the router has no way to check it: NEAR has no ZEC feed
with depth, and `quote_hash` is an opaque relay handle a contract cannot resolve.

A descending auction removes the question. The router offers a sequence of prices, high to low, one
live at a time. The first solver willing to take one, takes it. Nobody supplies a price — every level
is a function of the published terms and elapsed time, so `amount_out` leaves the interface entirely.

```
rate
  ▲
  │ ●  startRate                    level 0   [t0, t1)
  │   ●                             level 1   [t1, t2)
  │     ●                           level 2   [t2, t3)
  │       ●   ← solver fills here   level 3   [t3, t4)
  │         ·
  │           ·  minOutPerIn        reserve — ladder stops
  └──────────────────────────────► t
```

Being too high costs time. Being too low costs money. The two are not symmetric, so the ladder always
starts above the expected clearing price and walks down.

---

## 1. Quote terms

Five fields describe the auction. They join the terms `IntentQuoteEmitter.publishQuote` already
publishes, and like the rest they are hashed into `authPath` — the account derives from the whole
quote, so publishing someone else's terms still derives _their_ account and can only pay _them_.

```solidity
struct Quote {
    bytes32 quoteId;
    uint8   recipientKind;
    string  destinationAsset;
    string  recipient;
    // ─── auction ───
    uint128 startRate;      // ladder top, destination units per 1e18 of input
    uint128 minOutPerIn;    // ladder bottom — the reserve, and the user's limit price
    uint8   levels;         // K, bounded by NEAR's gas cap
    uint32  stepSecs;       // how long each level is live
}
```

`startRate` and `minOutPerIn` are rates, not amounts, so one quote serves every tranche whatever its
size. Amounts are never committed: the relay fee is deducted in flight and each tranche differs, so
the router reads the balance itself.

Encode a rate as **destination smallest-units per 1e18 of input**. ZEC has 8 decimals, so 20 ZEC per
ETH is `20 × 1e8 = 2_000_000_000`.

`maxSlippageBps` has no role here. `minOutPerIn` is the floor directly, expressed as a price rather
than a tolerance around a reference the router cannot see.

> **Changing the limit means a new schedule.** Every field is in the path, so republishing with a
> different `minOutPerIn` derives a different account. That keeps publishing permissionless and
> safe — no field exists that a stranger could rewrite to weaken someone else's floor. The cost is
> that a residual balance in the old account needs a way out, which the current terms do not carry.
> See §6.

### Wire format

Append to [`IntentCodec`](../../contracts/src/intents/IntentCodec.sol) and bump `VERSION` to `2`,
which is what the version byte is for — a new layout derives disjoint accounts, so nothing has to
migrate.

```
offset  size  field              offset  size  field
     0     1  version                51    16  minOutPerIn
     1    32  quoteId                67     1  levels
    33     1  recipientKind          68     4  stepSecs
    34     1  destAssetLen (D)       72     D  destinationAsset
    35    16  startRate            72+D     1  recipientLen (R)
                                   73+D     R  recipient    total 73 + D + R
```

Fixed prefix through `stepSecs` is 72 bytes — the v2 equivalent of `ORDER_HEADER_SIZE`.

---

## 2. Router state

```rust
pub struct Path {
    /// Terms hash from the VAA — the MPC derivation path, and this map's key.
    id: [u8; 32],
    /// Decoded once at registration. Immutable: the path *is* their hash.
    terms: Terms,
    /// The ladder currently live, if any. One at a time, always.
    ladder: Option<Ladder>,
    epoch: u64,
}

pub struct Ladder {
    epoch: u64,
    /// Input balance the levels were sized against.
    balance_in: u128,
    /// Unix seconds level 0 became live.
    started_at: u64,
    /// Shared by every level — see below. One ladder, one nonce.
    nonce: [u8; 32],
    /// amount_out per level, descending. levels[K-1] is the reserve.
    levels: Vec<u128>,
}
```

**One live ladder per path is the invariant the whole design rests on.** Two ladders mean two levels
valid at the same moment, and a solver takes whichever is worse for us — at which point it is a menu,
not an auction. `finalize` is therefore idempotent: a live, unexpired ladder is returned, never
replaced.

### One nonce for the whole ladder

`nonce = sha256(path ‖ u64_be(epoch))` — derived per **ladder**, not per signature, and every one of
the K payloads carries it.

NEP-413 nonces are consumed per signer account, so the first level a solver fills consumes it and
**every remaining level becomes permanently invalid**. That is the semantics the ladder wants: one
order, offered at descending prices, fillable once.

It is also what makes the design safe without the router ever learning that a fill happened. Give
each level its own nonce and the unfilled ones stay valid until their deadlines — live options
against whatever lands in the account next:

```
ladder sized to 0.4 ETH, levels 3.0 … 1.9 ZEC/ETH
level 3 fills at 2.4     → balance 0, but levels 4–6 remain signed and unexpired
next tranche lands 0.4   → level 4 is fillable again, now at a stale 2.2
```

A solver simply waits for the next tranche and takes the cheap one. The shared nonce closes that as a
protocol invariant rather than as bookkeeping the router cannot do.

The two protections are separate and neither substitutes for the other:

| | protects | failure without it |
| --- | --- | --- |
| shared nonce | quantity | stale levels fill against later tranches |
| disjoint deadlines | price | every level live at once, solver takes the cheapest |

---

## 3. `register` and `finalize`

Two entry points, because they answer two different events. A quote is broadcast once; a balance
lands many times.

```rust
/// On quote broadcast. Verifies the VAA and opens a path. Idempotent.
pub fn register(&mut self, vaa: Vec<u8>) -> [u8; 32]

/// On a balance landing. Opens a ladder against stored terms.
pub fn finalize(&mut self, path: [u8; 32]) -> Promise
```

The VAA is consumed **once**, not once per tranche. Terms are immutable and the path is their hash,
so re-verifying guardian signatures every tranche would pay for 13 signature recoveries to re-learn
something that cannot have changed.

Both are safe to leave **permissionless**. `register` takes bytes the guardians signed and stores
them under their own hash, so no caller can register terms that hash to someone else's path.
`finalize` takes no price and no amount — the worst a stranger achieves is paying gas to start a
ladder the terms already determined.

```
register(vaa)
  1. verify VAA             guardian set, emitter == IntentQuoteEmitter on chain 73
  2. decode terms           IntentCodec v2 layout
  3. path := keccak(terms)  already registered → return it, do nothing
  4. store Path { terms }   caller attaches the storage deposit

finalize(path)
  1. load terms             registered, so nothing to verify
  2. read balance           mt_batch_balance_of(A, "nep141:eth.omft.near")   [promise]
     └─ callback:
  3. require balance > 0
  4. require no live ladder else return the existing one, unchanged
  5. epoch += 1; nonce := sha256(path ‖ u64_be(epoch))                       one per ladder
  6. build levels           linear from startRate down to minOutPerIn over K steps
  7. sign K payloads        shared nonce; deadline = next level's start       [K promises]
  8. store ladder, emit every signed payload
```

Step 4 is the one guard that matters. A path being already registered is the steady state — every
tranche after the first hits it. A ladder being already live is not: minting a second means two
levels valid at once, which is the invariant in §2.

Step 5 increments the epoch **before** deriving the nonce, so a ladder that expired unfilled cannot
collide with its successor. A failed `sign` burns the epoch rather than the nonce being reused — the
cheaper mistake, since a reused nonce would silently invalidate a whole ladder.

The storage deposit `register` attaches is a one-time cost per schedule, refundable if the path is
closed. It buys away a guardian verification on every tranche for the life of the DCA.

Level `k`, sized to the balance just read:

```rust
let span = start_rate - min_out_per_in;
let rate = start_rate - span * (k as u128) / ((levels - 1) as u128);
let amount_out = balance_in * rate / 1e18;

let valid_from = started_at + k * step_secs;          // implied by the previous deadline
let deadline   = started_at + (k + 1) * step_secs;    // signed into the payload
```

Consecutive deadlines make the levels disjoint in time, which is what lets every payload be published
immediately without a solver being able to pick the cheapest. **This is the load-bearing assumption**
— see §7.

Linear interpolation is chosen for legibility. Geometric decay (`rate × (1 − stepBps)^k`) tracks
proportional price moves more naturally and is a drop-in change to this one expression.

### What happens after

**Nothing, and the router never finds out.** Settlement happens on `intents.near` via the bot's
`publish_intent`; no callback reaches back. The router signs K payloads and its involvement ends.

It does not need to know, because nothing depends on it knowing:

- **Quantity** is held by the shared nonce. The first fill consumes it and kills the rest.
- **Price** is held by the deadlines. Levels are disjoint whether or not anyone is watching.
- **The next ladder** is held by the clock. A new one cannot open until the previous window closes at
  `K × stepSecs` — minutes, against a tranche cadence of hours — so the router never has to
  distinguish *filled* from *expired unfilled*.

Which leaves both outcomes as correct terminal states. An unfilled ladder is not a failure: it is a
limit order that did not trigger, and the funds sit in the account for the next attempt.

The one place the distinction has value is seeding the *next* ladder from the rate that actually
cleared — and that is exactly why §8 is optional and why a report there may only ratchet the seed
upward. Tracking fills for its own state machine is the bot's job, via `get_status(intent_hash)` and
the balance. The router reads neither.

---

## 4. Off-chain harness

The bot discovers, triggers and publishes. It holds no keys that matter and cannot influence a single
price — compromising it delays a trade, never moves one.

```
 ON QUOTE BROADCAST
   spy subscription on IntentQuoteEmitter's emitter address (chain 73)
     └─ register(vaa) straight away
     └─ derive authPath → NEAR account A → deposit address 0xN, store the path

 ON BALANCE
   poll A's nep141:eth.omft.near balance
     └─ balance > 0 and no live ladder → finalize(path)

 PUBLICATION
   read the K signed payloads from the finalize receipt (or get_signed_intent)
   publish each to the relay when its window opens
     └─ a level that expires unfilled is simply superseded by the next
```

Registering on broadcast is what keeps the bot stateless about VAAs. The bytes are needed exactly
once, at the moment they arrive on the wire, and are never persisted or refetched. From then on the
bot works entirely in `[u8; 32]` paths.

**Missing the broadcast is recoverable, and not by the bot alone.** A quote gossiped while the bot is
down is invisible to a live subscription forever, so `register` must also be reachable from a cold
start: `scan` already indexes `QuotePublished` into `intent_quotes` with the sequence, and the bytes
refetch from the Wormhole API by `(chain, emitter, sequence)`. Since `register` is permissionless and
idempotent, anyone can close the gap — including the user.

**Publication is permissionless.** The signed payloads are emitted and readable, so if the bot goes
quiet anyone can push them to the relay. Liveness never depends on one process.

---

## 5. Cost

K signatures per tranche, and two numbers decide whether that is trivial or prohibitive:

|                    | constraint                                                |
| ------------------ | --------------------------------------------------------- |
| `K × SIGN_GAS`     | must fit NEAR's 300 TGas cap — this bounds K structurally |
| `K × SIGN_DEPOSIT` | paid per tranche, per schedule                            |

Both are unmeasured. Until they are, prefer a coarse ladder: fewer levels near the top where a fill is
unlikely, finer near the reserve where clearing actually happens.

**Who pays is unresolved.** The Ethereum leg funds itself — the relayer deducts its fee from the ETH
it delivers — and NEAR has no equivalent. Three options, in order of how little new machinery they
need:

1. **Fold it into `maxRelayFee`.** The mechanism already exists and works. NEAR gas plus the MPC
   deposit is small against a relay fee measured in the low `1e13` wei. Requires that whoever relays
   on Ethereum also finalizes on NEAR, which the `authorizedRelayer` allowlist can enforce.
2. **Operator prefunds the router.** Simplest, and acceptable because `finalize` cannot misdirect
   funds — `recipient` comes from the VAA. It is an operator subsidy that scales with tranche count.
3. **A fee intent in the payload.** Self-funding and permissionless, but the finalizer earns the
   destination asset while spending NEAR for gas, and the fee becomes a term of the signed payload.

---

## 6. Open: cancellation

An unfilled ladder leaves the balance in place, which is correct. A user who changes their mind has
no exit: `recipient` is an address in the destination asset, so withdrawing the _input_ asset there is
wrong, and no field carries a refund destination.

The additive fix is a `refundTo` in the path-committed terms plus a `cancel(vaa)` that signs a
withdraw-only payload for it. Safe by the same argument as `finalize` — the destination comes from
guardian-signed bytes, so anyone may call it.

Not designed here. It should be, before the first schedule holds real value.

---

## 7. Unverified

Add to [verification.md](verification.md). The first is blocking: the design does not work without it.

**⚠ Intent `deadline` bounds validity.** Consecutive levels must not be live simultaneously. If the
verifier treats `deadline` as advisory, or if a payload remains fillable before its window, a solver
takes the level worst for us and the auction inverts into a menu.

**⚠ The relay accepts an unmatched intent.** The published flow is
`publish_intent(quote_hashes, signed_data)`, which reads as binding to a solver quote obtained first.
A Dutch auction posts a limit and waits. If the relay requires a pre-agreed `quote_hash`, the bot must
shop each level to solvers instead — it still cannot change the price, since the level is signed, so
the design degrades rather than breaks. Confirm which.

**`SIGN_DEPOSIT` and `SIGN_GAS` per signature.** Decides K, and therefore the ladder's resolution.

**Whether `mt_batch_balance_of` can be read in the same call that signs.** The balance read is a
promise, so `finalize` is two-phase; confirm the callback can attach K signing promises within the gas
budget.

---

## 8. Later: self-calibration

`startRate` is published once and drifts. A ladder seeded from the **last level that actually
cleared** would track the market with no external price and no republication, converging on one or two
levels per tranche in steady state.

The router can observe a non-fill completely — ladder expired, balance intact, so the market is below
the bottom. It cannot observe _which_ level cleared. The shared nonce guarantees exactly one did, but
not which: with `recipientKind: 0` the destination asset leaves atomically, so there is no balance
delta to read, and nonce consumption happens inside `intents.near` where nothing reports back.

That gap needs a reported clear, and a report that can _lower_ the seed is an attack on price. The
safe asymmetry is to accept reports that raise it and derive falls from observed expiry — lying high
costs the liar nothing and costs us bounded time, lying low is impossible.

Worth building only once K is known to be expensive.
