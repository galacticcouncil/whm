# HOLLAR PSM — Base USDC

## Abstract

A peg stability module minting HOLLAR against USDC held in a reserve on Base. USDC is locked and
supplied to Aave v3 on Base; a Wormhole message attests it to Hydration, where a registered GHO
facilitator mints HOLLAR 1:1. Redemption burns HOLLAR on Hydration and books a claim against the
Base reserve, paid FIFO.

Nothing is bridged. The USDC never leaves Base and the HOLLAR is issued against a facilitator
bucket, so the corridor's outstanding claim is the bucket level and nothing else.

## Overview

Phase 1 of the cross-chain HSM ("HSM-X"): one corridor, one asset, one direction of inventory. Each
`(chain, asset)` pair is a separate deployment with its own facilitator bucket — the contracts carry
no per-asset branching, but they also share no ledger.

| | Base | Hydration |
|---|---|---|
| Contract | `HollarBaseVault` | `HollarBaseFacilitator` |
| Holds | USDC reserve, supplied to Aave v3 | nothing |
| Role | locks, attests, books and pays claims | mints and burns HOLLAR |
| Authority | admin · guardian · treasurer | admin · guardian |

## Architecture

### `HollarBaseVault` — Base

Holds the reserve. Inherits `MessageReceiver` (UUPS + Wormhole verification + replay guard) and
`AccessControlUpgradeable`.

- **`deposit(amount, recipient)`** — gates on the oracle, pulls USDC via `transferFrom(amount)`, then
  charges the rate limit, adds to `principal`, and publishes `KIND_MINT` against the vault's own
  observed balance delta across that transfer — never the caller's `amount` (xchain#55). Supplies
  to Aave best-effort afterward.
- **`receiveMessage(vaa)`** — verifies a `KIND_REDEEM` / `KIND_REFUND` message and **books an IOU**.
  It moves no money: the burn on Hydration is irreversible, so crediting must never be able to fail
  for want of liquidity. A redemption that lands above its own fee limit is not booked at all: the
  HOLLAR goes straight back.
- **`drain(maxEntries)` / `claim()`** — pay the queue head-first. Permissionless (`drain`) so nobody
  depends on us being online. A head USDC cannot reach is retired by `drain` only: their own
  `claim` reverts instead, leaving the credit queued and the cancel below still open to them.
- **`cancelQueuedRedemption(index)`** — the credit at the head is given up and its value goes back
  to the credit's `origin` — the Hydration account it came from — never to a caller's pick. The
  credit's `recipient` may ask at any time; its `origin` only for a redemption, and only once it
  has sat at the head unpaid for 24 hours. Head only, so the queue is only ever modified at the
  front. Gated by
  `claimsPaused` like `claim` and `drain`: it mints on Hydration, so a pause meant to stop a bad
  payout must stop this path too. `cancelQueuedRedemptionFor(index)` is the admin's copy — same
  gate, same books — for a head its owner cannot clear.
- **`claimUnpayable(recipient)`** — pays out a credit that was retired because its recipient could
  not receive USDC, once that clears.
- **`emergencyUnwindAave(amount)`** — guardian; pulls the reserve out of Aave and stops deposits
  from re-supplying it until `setInvestPaused(false)`.

Reserve accounting: `principal` (attested, not yet redeemed), `totalOwed` (queued),
`totalUnpayable` (retired because the recipient cannot receive), `disputed` (over-claims — a
record, it pays nothing). `surplus()` is assets less the first three; `sweepable()` is surplus
less a floor.

### `HollarBaseFacilitator` — Hydration

Registered on the HOLLAR token as an independent GHO facilitator, so everything it can do is bounded
by its own bucket.

- **`receiveMessage(vaa)`** — verifies a `KIND_MINT` / `KIND_REMINT` message and mints. Must not
  revert on anything the far side controls: paused, bucket-full and rate-limited all **queue**
  instead — one entry per message, keyed by id and remembering which kind it came as, in the
  storage shape `BasejumpLanding` uses for pending transfers. It still reverts on a payload the
  vault could not have produced — wrong kind, unusable recipient, zero amount — leaving the VAA
  unconsumed.
- **`flushPendingMint(id)`** — mints that entry, whole, once the blocker clears. No amount
  argument: all-or-nothing. Entries are independent, so one the bucket cannot cover reverts and
  blocks nothing else.
- **`cancelPendingMint(id, maxFeeBps)`** — give up on an entry and send the USDC back on Base, to
  the entry's `origin` — the Base account the value came from. A queued deposit goes back as a
  fee-free `KIND_REFUND`; a queued re-mint goes back as `KIND_REDEEM` and pays the fee, because it
  is burned HOLLAR leaving as USDC — `maxFeeBps` is the limit that redemption carries, and is read
  for nothing else. Gated by neither pause: it is the way out of the queue and stays open exactly
  when entries queue; the credit it books on Base still waits behind the vault's `claimsPaused`.
  `cancelPendingMintFor(id, maxFeeBps)` is the admin's copy; `PendingMintCancelled`
  carries the kind that went
  back. Ids come from `MintQueued`; `pendingEntryOf(recipient, fromId, maxIds)` walks only that id
  window, since ids are never reclaimed. `maxRedeemable` / `mintHeadroom` read zero under their
  pause, as the vault's `claimable` does under `claimsPaused`.
- **`redeem(usdcAmount, baseRecipient, maxFeeBps)`** — burns HOLLAR and publishes `KIND_REDEEM`
  carrying the most the redeemer will pay.

The solvency model is not in this contract. `GhoToken.burn` computes `bucketLevel - amount` with no
floor, so 0.8 underflow means this facilitator can never redeem past what it minted — including
HOLLAR minted elsewhere (borrowed, or via the existing HSM) that a holder walks in with.

## Flow

```
DEPOSIT   user ──USDC──▶ Vault ──▶ Aave          Vault ──KIND_MINT──▶ Facilitator ──mint──▶ user
REDEEM    user ──HOLLAR──▶ Facilitator ──burn    Facilitator ──KIND_REDEEM──▶ Vault ──▶ FIFO queue
RETURN    (redeem over its fee limit)  Vault ──KIND_REMINT──▶ Facilitator ──mint──▶ redeemer
CANCEL    (queued redemption)  Vault ──KIND_REMINT──▶ Facilitator ──mint──▶ redeemer
CANCEL    (queued refund)      Vault ──KIND_MINT────▶ Facilitator ──mint──▶ deposit's recipient
CANCEL    (queued deposit)     Facilitator ──KIND_REFUND──▶ Vault ──▶ FIFO queue, no fee
CANCEL    (queued re-mint)     Facilitator ──KIND_REDEEM──▶ Vault ──▶ FIFO queue, fee as on redeem
```

Consistency is chosen per call site, not per kind — `KIND_MINT` and `KIND_REDEEM` each serve an
entry and an exit. Deposits and redeems publish at 200 (instant): guardians sign on inclusion.
Exits — a cancel on either side and a fee-limit return — publish finalized: Wormhole treats any
level other than 200 and 201 as finalized, and the contracts use 1, the value its SDK names
`Finalized`. Finality costs latency, about 17 minutes on Base (512 blocks) and well under that on
Hydration, which an exit can afford.

## Payload encoding

100 bytes, big-endian, one definition shared by both ends (`PsmPayload`):

```
┌───────┬───────┬─────────────┬─────────────┬─────────────┬─────────────┐
│  [0]  │  [1]  │  [2 .. 34)  │ [34 .. 66)  │ [66 .. 98)  │ [98 .. 100) │
│version│ kind  │  recipient  │   amount    │   origin    │  maxFeeBps  │
└───────┴───────┴─────────────┴─────────────┴─────────────┴─────────────┘
```

`recipient` and `origin` are left-padded H160s; `amount` is USDC units, 6 dp. `maxFeeBps` is read on
`KIND_REDEEM` only; `0xffff` sets no limit.

Kinds: `1` MINT and `4` REMINT (Base→Hydration), `2` REDEEM and `3` REFUND (Hydration→Base).

`origin` is the account that signed the originating transaction on the source chain — the
depositor on Base, the redeemer on Hydration — the one address guaranteed to exist there, so it is
where a cancellation on the far side sends the value back. A cancellation swaps the pair: the
message it publishes is addressed to the old `origin` and names the old `recipient` as its own.

The wire always carries **USDC units, never HOLLAR units**. USDC is the coarser of the pair, so
conversion is lossless in both directions and dust is structurally impossible. There is no asset
field: each corridor is bound to exactly one vault emitter, so the asset is implied.

Packed rather than `abi.encode`: a fixed-width body behind a version byte is append-only by
construction, and VAAs are permanent, so a shape change would strand every unrelayed message.

## Key design decisions

**Crediting never moves money.** The one irreversible step (the burn) happens first and on the other
chain. A credit that could fail would destroy a user's HOLLAR and give nothing back, so the vault
takes on the debt and settles separately.

**Whole-fill, on both queues.** A queued credit is paid in full or not at all, and a queued mint
mints in full or not at all. Part-filling would consume the liquidity — or the bucket headroom —
that other claims are waiting on while leaving a remainder still outstanding, so a trickle would
keep the queue permanently busy and stationary.

**Ordered on the redeem side, unordered on the mint side.** The vault's claim queue is FIFO because
claims compete for one scarce reserve and arrival order *is* the fairness guarantee — which is what
creates its head-of-line residual, answered by `cancelQueuedRedemption`. Both ways out of that
queue — paid or cancelled — act on the head and nothing else, so no slot behind it is ever
zeroed and no later caller inherits a walk over one. The mint queue rations
nothing: no one was promised a place, and bucket headroom returns as HOLLAR is redeemed. Ordering it
would only mean an entry the bucket cannot cover holds up every smaller one behind it, so entries
are independent and flushable by id. An unmintable one reverts its own flush and blocks nobody; its
recipient waits for a bucket raise or leaves via `cancelPendingMint`.

**A recipient who cannot be paid does not hold the line.** USDC on Base is blacklistable, so
`transfer` to a sanctioned address reverts for the sender. The transfer is isolated: if it fails the
entry retires into `unpayable` — still owed, still a liability, payable later via `claimUnpayable` —
and the queue advances. Sourcing liquidity from Aave is *not* isolated: if Aave will not release the
money that reverts and the claim stays queued, because that is a reserve problem, not a recipient one.

A retired credit is senior to every live entry — it was ahead of all of them when it retired — so
`claimUnpayable` draws on the reserve without regard to the queue. Retirement is terminal: the fee
is released then, and there is no cancel back from `unpayable` — a recipient Circle never clears
has no exit short of an upgrade, which is accepted. The one path that retires someone is the
permissionless `drain`; a blacklisted head calling `claim` is refused with the credit intact, so a
user cannot retire themselves by accident. `drain` sources every entry's liquidity from Aave inside
one batch, so a later entry Aave refuses reverts the whole batch; `drain(1)` is the keeper fallback
during an Aave pause, for what idle USDC covers. The mirror image: with the reserve idle (after an
unwind) a token-wide USDC pause would let `drain` retire every head instead of reverting, so an
unwind is paired with `setClaimsPaused(true)` — the guardian holds both levers.

**The redeemer can leave, from the head.** Whole-fill means a head larger than the reserve can
release stalls the line, and the burn already happened. `cancelQueuedRedemption` returns `gross` to
`principal` and re-mints the same figure, so the corridor lands exactly where it stood. It applies
to the head only — which is where the stall is by definition — and everyone behind leaves in turn.
The credit's `recipient` may ask at any time. Its `origin` may ask too, under two limits; the
value goes back to the origin either way. Only once the credit has sat at the head unpaid for
`ORIGIN_CANCEL_DELAY` — 24 hours, counted from reaching the head (`headSince`), not from booking:
a credit that queued behind a stall is about to be paid the moment the stall clears, and a head
the reserve can cover is paid within minutes. And only for a redemption: a refund's origin is the
deposit's recipient on Hydration, who put nothing in and has no claim on the depositor's refund.
A redeemer who named a payment address they do not control — an off-ramp's — therefore has an
exit from a real stall, and no way to recall a payment the queue is about to make.

**A cancelled re-mint is a redemption.** The facilitator's queue remembers which kind an entry
came as. Cancelling a queued deposit refunds fee-free (`KIND_REFUND`); cancelling a queued re-mint
— burned HOLLAR whose redemption was walked away from at the vault's head — goes back as
`KIND_REDEEM`, and the vault books the same credit, fee included, that the cancellation undid.
Without the distinction, redeem → cancel at the head → let the re-mint queue → cancel it was a
fee-free redemption, reachable at will: whenever the day's inbound window is spent — as a
full-window mint leaves it — the re-mint queues. Walking the loop again is a fixed point — the
same credit comes back every time and the fee is paid once, on payout.

**A cancelled refund is a deposit again.** The vault's queue remembers the same thing about its own
entries. A refund credit is a deposit that never minted, so cancelling it at the head attests the
deposit again (`KIND_MINT`) rather than re-minting — and a second cancel on Hydration refunds it in
full. Value that burned travels as REDEEM / REMINT and value that never minted as MINT / REFUND,
however often either is cancelled, so the fee is charged on every redemption and on nothing else.

**A redemption carries its own fee limit.** The fee is assessed on Base when the credit lands, not
when the HOLLAR burns, so the burn names the most its redeemer will pay — `maxFeeBps`, the last
field on the wire. Above it the vault books nothing, `principal` stands, and the HOLLAR goes back
to the redeemer as a re-mint in the same delivery. A cancelled re-mint, being a redemption,
carries its canceller's limit the same way. A `setFees` that lands inside the relay window
therefore cannot re-price a burn that cannot be undone. Three consequences, recorded rather than
hidden. The return mints on Hydration, so while claims are paused such a delivery reverts and lands
once they are not. It publishes from a non-payable delivery, which holds only while the Wormhole
message fee is zero — it is on both chains; were that to change, the delivery reverts the same way
and the VAA stays replayable, and lowering the fee to within its limit books it instead. And a
limit set below the standing fee is a free round trip: it moves one Base transaction from the
redeemer to the relayer and spends the two rate-limit windows — as a cancel at the head already
could, but without needing the head, so one holder of the whole bucket can close both windows for
a day for gas alone. A credit already booked can still be re-booked at
the current fee by cancelling it, so fee changes are best made while the claim queue is empty.

**An unwind is sticky.** `_investBestEffort` sweeps the whole idle balance after every deposit, so
without a stop a deposit of any size after `emergencyUnwindAave` would put the entire reserve back
into the pool the guardian had just left. The unwind therefore sets `investPaused`; deposits still
lock, attest and publish, they just stay idle until a guardian clears it — which re-supplies the
idle balance at once.

**A reorg is an accepted residual for deposits and redeems, and closed for exits.** Publishing at
200 means guardians sign on inclusion, so a reorg that unwinds a deposit after its VAA is signed
leaves that HOLLAR unbacked, and one that unwinds a redeem leaves a credit for HOLLAR that was never
burned. An earlier design gated deposits above a cap onto consistency 201; the cap was removed
because 200 is the deliberate choice for both, regardless of size. What bounds that is
`DEPOSIT_LIMIT_CAPACITY`, the outbound limit and the facilitator bucket — each exposure needs fresh
capital inside those limits — and the remedy for a breach is unchanged: burn the difference from
treasury. Supersedes xchain#40. Exits are different. A cancel or a fee-limit return sends value
back with nothing new locked or burned; it costs nothing, is not rate-limited and can be repeated
with the same funds, so at 200 one holder could keep a whole position continuously exposed and
collect on any reorg. A return is also triggered by a VAA that becomes deliverable again if its
delivery is reorged out. Exits therefore publish finalized.

**Payouts are sized by Aave's virtual balance.** `getVirtualUnderlyingBalance` is the figure
`withdraw` decrements; the aToken's raw holding also counts donations Aave never releases (measured
at 230.72 USDC on Base, and anyone can widen it). Overstating does not merely overpay — it sizes a
payout Aave refuses and reverts the whole call.

**Deposits are sized by the observed balance delta, not the caller's argument (xchain#55).**
`deposit` reads the vault's USDC balance immediately before and after `transferFrom`, and charges
the rate limit, books `principal`, and publishes the mint against that delta — never `amount`. A
token that moves less than requested would otherwise let the rate limit, the books, and the minted
figure all disagree with what the reserve actually holds. The read brackets only the transfer, not
the Aave supply that follows, so best-effort investing never pollutes it.

The delta is trustworthy only because nothing else is supposed to move this balance inside the
bracket — there is no reentrancy guard, so that is an assumption, not a guarantee. A token whose
`transferFrom` calls back into a second `deposit` can land real funds in the vault before the outer
frame's own transfer completes, and an uncapped read would then book them twice: once for the
nested call, again for the outer one. The residual is closed by capping the observed delta at
`amount` — the worst any single call can ever book is what it itself asked to move, exactly the
pre-delta behaviour — not by adding a guard. A zero delta (after capping) reverts with the named
`ZeroAmount` error rather than booking a no-op deposit; a token that leaves the vault's balance
*lower* than before the transfer underflows the subtraction instead and reverts on its own
(`Panic(0x11)`), uncaught and unnamed — there is no delta value between those two cases.

The cap bounds inflation only. A token that called a third party inside `transferFrom` could run
the permissionless `drain` or `claimUnpayable` from idle USDC inside the bracket and deflate the
delta, under-crediting the honest depositor into `surplus()`. Circle USDC has no hooks and `usdc`
is pinned at init, so this is recorded, not guarded.

**The emitter chain is pinned, and nothing is accepted before the bind.**
`MessageReceiver._onlyAuthorizedEmitter` compares against `authorizedEmitters[chain]`, which is
`bytes32(0)` for any unbound chain — including each contract's own pinned chain until its one-shot
bind runs — so a zero-emitter VAA matches the mapping default there. Each PSM contract's
`_processMessage` therefore refuses everything while `emitterFrozen` is false, and any
`emitterChainId` other than the one it is bound to afterwards. Fixed PSM-side deliberately:
`MessageReceiver` is shared with deployed basejump and oracle contracts. A zero emitter is not
producible through the Wormhole EVM core, which stamps the caller; this is hardening, not an exploit.

**Emitter binding is one-shot.** `setBaseEmitter` / `setHydrationEmitter` freeze themselves. The
highest-value key in the system is not a live setting; a wrong value means redeploying that side.

**No minimum deposit or redemption.** Both were removed as configurable dials. The consequence is
recorded rather than hidden: dust redemptions are now possible, so the claim queue can be stuffed
with entries worth nothing, and the outbound rate limit caps redeemed *value*, not the *count* of
redemptions — nothing bounds the entry count directly. What bounds the damage is that every entry
leaves the queue at the head and costs one entry's work to retire, whether it is paid or cancelled.
So stuffing is a griefing cost, paid one entry at a time by whoever calls `drain`, and `drain`'s
`maxEntries` lets that caller bound their own spend. It is not a stall, and no caller can be made to
absorb the whole pile in a single transaction — which is what an unbounded scan over retired slots
would have meant, given the count is unbounded.

**No per-credit hold, and no way to erase one.** Large credits were once parked for 24 h where an
admin could void a forged one, restoring `principal` and leaving everyone else paid. That mechanism
was removed: its threshold was evaded by splitting one redemption into several, and it defended a
forged attestation — which needs a Wormhole guardian compromise, a threat excluded everywhere else
here. The remaining lever is `setClaimsPaused`, which differs in two ways worth stating plainly. It
is **collective**: stopping a forged payout stops every payout, and also every `cancelQueuedRedemption`
— a paused incident must not let a queued entry convert into a fresh mint on Hydration instead of a
Base payout. And it **refuses to pay rather than erasing** — the credit stays a liability, so
`surplus()` stays depressed by it and only an upgrade removes it.

**Ownership is retired at init.** `owner = address(0)` in the initializer, so the inherited
`setOwner` and `setAuthorizedEmitter` are permanently uncallable and roles are the only authority.

**Init refuses what no setter can fix.** Each side checks the counterpart's Wormhole chain id
against its own core's — zero or equal is refused, and the read proves the core address — and the
facilitator refuses zero USDC decimals, which would have made every wire unit a whole HOLLAR.

## Runtime circuit breaker

Hydration's circuit breaker hooks `pallet_currencies` — the global withdraw limiter and the
issuance fuse. The facilitator's `mint`, `burn` and `transferFrom` execute inside the GHO ERC20
itself and never pass through it; the same is true of `pallet_hsm`'s own mints and burns, so this
is a property of HOLLAR facilitators, not of this module. Substrate-side HOLLAR moves are hooked
normally (HOLLAR is overridden to `GlobalAssetCategory::Local` and priced for the limiter). The
corridor's issuance controls are its own: the GHO bucket, the inbound / outbound limits and the
guardian pause. A circuit-breaker lockdown therefore does not stop this corridor — the batch that
triggers one should include `facilitator.setPaused(true, true)` through the dispatcher.

## Keepers

Two calls nobody is forced to make, both permissionless and gas-only. They belong to the relayer —
each in the process that already owns that chain's wallet — and are driven by chain state, not by
what the relayer itself delivered: anyone may deliver a VAA.

- **`drain(maxEntries)` on Base.** The only thing that pays a recipient who will not call `claim`
  — a payment address, an off-ramp's. Send it when the head is payable (`claimable(head) > 0`),
  with `maxEntries` around 10: measured on a Base fork, about 60k gas for a call that pays nothing
  and about 260k per entry paid out of Aave. If a batch reverts, fall back to `drain(1)`.
- **It should not be what retires a head.** A head that is payable but whose simulated `drain(1)`
  pays nothing has a transfer that is failing; draining it retires the credit, which takes the fee
  and leaves no cancel. Alert instead — the admin's `cancelQueuedRedemptionFor` returns the gross.
  Best effort only: `drain` is open to anyone.
- **`flushPendingMint(id)` on Hydration.** Per entry, and it reverts on a shortfall, so simulate
  first. Take ids from `MintQueued` and schedule by its reason: a pause lifts on `PausedSet`, a
  full bucket on a redemption or a capacity raise, a spent window after
  `amount ÷ (capacity ÷ window)` seconds.

## Deviations from the HSM spec

The HSM spec (`galacticcouncil/xchain`, `specs/hsm-spec.md`) specifies redemption as a **two-step
escrowed intent**. This implements a **direct burn**. Recorded rather than argued:

| | Spec | Built |
|---|---|---|
| HOLLAR on redeem | escrowed, burned at fill | burned immediately |
| Queue location | Hydration, per exit chain | Base, in the vault |
| Liquidity check | before the message, via an attested report | none |
| Stuck redeemer | cancel or re-route on an intact escrow | `cancelQueuedRedemption` at the head, one round trip |
| Ledger | global from day one (I1) | per corridor |

The spec names head-of-line blocking as an accepted residual precisely because nothing is burned
until fill. This implementation inherits the residual and answers it with cancellation instead.
Consequence: a redeemer who entered via Base can only exit via Base, and a second corridor is the
per-corridor→global ledger migration that I1 was written to avoid.

A staleness check on the price was specified and **deliberately not implemented**. The feed behind
Aave's price updates on deviation as well as on its 24 h heartbeat, so a real depeg moves
`getAssetPrice` and the floor catches it; age would only have caught a feed frozen outright, and the
cost was a second oracle address per asset that nothing could validate as describing the same asset.

Also not implemented: the attested liquidity report, exit-chain choice, re-route, and CCTP
rebalancing. `min(1, HOLLAR market price)` redemption pricing is not implemented — redemption
settles at a flat 1:1 less `redeemFeeBps`.

Superseding decisions on record: section 8c's reorg mitigation (xchain#40) is not implemented — see
"A Base reorg is an accepted residual" above; the flat 5 bps fee replaces the peg-band fee posture (xchain#41); there is no upgrade timelock, the
4-of-7 threshold standing in for it (xchain#42).

## Parameters

Launch values, `migrations/envs/<context>/psm-base.env`:

| Env | Value | Bounds |
|---|---|---|
| bucket capacity | 10,000 HOLLAR | Total outstanding. Granted on Substrate, **not by this migration**. |
| `DEPOSIT_LIMIT_CAPACITY` | 10,000 / 24 h | Inflow. Worst case over an arbitrary window is 2× capacity. |
| `INBOUND_CAPACITY` / `OUTBOUND_CAPACITY` | 10,000 / 24 h | Mint / redeem velocity. Outbound deliberately not tighter — this is the primary redemption route. It bounds burns; a cancelled re-mint is not charged to it (that value burned under the limit already), nor stopped by `redeemPaused` — the vault's `claimsPaused` holds what it books. |
| `REDEEM_FEE_BPS` | 5 | Charged when USDC leaves: a redemption, or a cancelled re-mint. A cancelled deposit's refund carries none. Capped at 500. |
| `SURPLUS_FLOOR_BPS` | 25 | Held back from the treasurer. Capped at 10,000. |
| `MIN_USDC_PRICE` | $0.99 (8 dp) | Deposits refuse below it; redemption stays open. The whole mint gate, and fixed at init — there is no setter. |

Finite rate-limit capacities are bounded at 2¹²⁸ − 1 (`RateLimiter.MAX_CAPACITY`); unlimited is
asked for by name. Closing a limit with `setLimits(0, …)` and reopening it starts the window empty
for a full period — emergencies use `setPaused`.

## Deployment

```sh
FOUNDRY_PROFILE=psm pnpm --filter @whm/contracts build   # only when invoking the runner directly; the wrapper builds
pnpm migrate:psm-base:fork
pnpm migrate:psm-base
```

Nine steps: deploy both proxies, bind emitters (one-shot), set limits / fees, hand
`DEFAULT_ADMIN_ROLE` to its permanent holder and renounce the deployer's.

Two things the migration deliberately does **not** do, because neither is ours to run:

- `GhoToken.addFacilitator(facilitator, label, capacity)` — Hydration governance: the GHO roles sit
  on the dispatcher's AaveManager account, so it is `dispatch_as_aave_manager` from Root or the
  EconomicParameters track. Until it lands the facilitator has a zero bucket and mints nothing.
- **Unpausing.** Both contracts ship paused. Once the migration has bound both emitters (005/006),
  the go-live order is redeem unpaused → mint unpaused, once the bucket is granted and the
  invariant has been watched → the vault's deposits last, each a guardian action. Deposits go last
  because a deposit that lands while mint is paused only queues, and a queue → cancel → refund loop
  spends the deposit window for free.

The runner resumes a `failed` step on every invocation and `--from <next>` does not skip it. The
emitter binds read before they write — an already-bound value is idempotent, a different one throws
— and the handovers refuse the deployer itself; the vault's also refuses an admin with no code.

The PSM uses its own Foundry profile (`[profile.psm]`: optimizer on, 200 runs, `out-psm/`) because
`HollarBaseVault` does not fit under EIP-170 unoptimised. The default profile is untouched so
nothing already deployed changes bytecode. `sh/migrate-psm-base.sh` builds it before running.

## Testing

```sh
FOUNDRY_PROFILE=psm forge test --match-path "test/psm/**"    # fork suites skip without RPC_BASE / RPC_HYDRATION
npx tsx chopsticks/probes/_probePsmRedeem.ts                 # the redeem leg, real runtime
```

Fork suites run against live chain state and skip cleanly without an RPC:

- `fork/BaseAaveFork` — real Aave v3.3 and Circle USDC; the virtual balance is mocked under the
  squeeze cases and the Chainlink feed is exercised only through `deposit`'s oracle gate. The
  blacklist is emulated in `unit/QueueHeadBlockTest`.
- `fork/HydrationFacilitatorFork` — the real GHO contract's bucket arithmetic, mint and burn.

`transferFrom` on HOLLAR resolves its allowance through a Substrate runtime precompile that anvil
does not have, so the full redeem leg cannot run under Foundry — it is mocked in the fork suite and
exercised for real by the chopsticks probe.

## Contract reference

| Contract | Chain | Notes |
|---|---|---|
| `HollarBaseVault` | Base | UUPS. Reserve, Aave, FIFO queue, surplus. |
| `HollarBaseFacilitator` | Hydration | UUPS. GHO facilitator, mint queue, redeem. |
| `PsmPayload` | library | The 100-byte wire, one definition for both ends. |
| `RateLimiter` | library | Continuously-refilling budget; zero is closed, never unlimited. |
