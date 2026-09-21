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
  for want of liquidity.
- **`drain(maxEntries)` / `claim()`** — pay the queue head-first. Permissionless (`drain`) so nobody
  depends on us being online.
- **`cancelQueuedRedemption(index, hydrationRecipient)`** — the redeemer at the head gives up their
  place and takes the HOLLAR back, re-minted to the named Hydration recipient rather than implicitly
  to the Base caller. Head only, so the queue is only ever modified at the front. Gated by
  `claimsPaused` like `claim` and `drain`: it mints on Hydration, so a pause meant to stop a bad
  payout must stop this path too.
- **`claimUnpayable(recipient)`** — pays out a credit that was retired because its recipient could
  not receive USDC, once that clears.

Reserve accounting: `principal` (attested, not yet redeemed), `totalOwed` (queued),
`totalUnpayable` (retired because the recipient cannot receive), `disputed` (over-claims).
`surplus()` is assets less those; `sweepable()` is surplus less a floor.

### `HollarBaseFacilitator` — Hydration

Registered on the HOLLAR token as an independent GHO facilitator, so everything it can do is bounded
by its own bucket.

- **`receiveMessage(vaa)`** — verifies a `KIND_MINT` message and mints. Must not revert on anything the
  far side controls: paused, bucket-full and rate-limited all **queue** instead — one entry per
  message, keyed by id, in the storage shape `BasejumpLanding` uses for pending transfers.
- **`flushPendingMint(id)`** — mints that entry, whole, once the blocker clears. No amount
  argument: all-or-nothing. Entries are independent, so one the bucket cannot cover reverts and
  blocks nothing else.
- **`cancelPendingMint(id, baseRecipient)`** — give up on an entry and take the USDC back on Base.
- **`redeem(usdcAmount, baseRecipient)`** — burns HOLLAR and publishes `KIND_REDEEM`.

The solvency model is not in this contract. `GhoToken.burn` computes `bucketLevel - amount` with no
floor, so 0.8 underflow means this facilitator can never redeem past what it minted — including
HOLLAR minted elsewhere (borrowed, or via the existing HSM) that a holder walks in with.

## Flow

```
DEPOSIT   user ──USDC──▶ Vault ──▶ Aave          Vault ──KIND_MINT──▶ Facilitator ──mint──▶ user
REDEEM    user ──HOLLAR──▶ Facilitator ──burn    Facilitator ──KIND_REDEEM──▶ Vault ──▶ FIFO queue
CANCEL    (queued claim)   Vault ──KIND_MINT──▶ Facilitator ──mint──▶ user
```

Consistency: every message on this route publishes at 200 (immediate) — the chosen level, not the
only one available. The Wormhole guardian set supports 201/safe and 202/finalized for both Base
and Hydration on these contracts; this route does not use them. What bounds the instant-level risk
is the facilitator bucket and the deposit rate limit, not a slower consistency level.

## Payload encoding

66 bytes, big-endian, one definition shared by both ends (`PsmPayload`):

```
┌───────┬───────┬──────────────────────────────┬──────────────────────────────┐
│  [0]  │  [1]  │           [2 .. 34)          │          [34 .. 66)          │
│version│ kind  │  recipient — left-pad H160   │  amount — USDC units, 6 dp   │
└───────┴───────┴──────────────────────────────┴──────────────────────────────┘
```

Kinds: `1` MINT (Base→Hydration), `2` REDEEM, `3` REFUND (both Hydration→Base).

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

**The redeemer can leave, from the head.** Whole-fill means a head larger than the reserve can
release stalls the line, and the burn already happened. `cancelQueuedRedemption` returns `gross` to
`principal` and re-mints the same figure, so the corridor lands exactly where it stood. It applies
to the head only — which is where the stall is by definition — and everyone behind leaves in turn.

**A Base reorg is an accepted residual, not a bounded one.** Publishing at 200 means guardians sign
on inclusion, so a reorg that unwinds a deposit after its VAA is signed leaves that HOLLAR unbacked.
An earlier design gated deposits above a cap onto consistency 201. Safe (201) and Finalized (202)
are available on both Base's and Hydration's guardian sets; the cap was removed because 200 is the
deliberate choice for the whole route regardless of size, not because a slower level was
unreachable. What bounds the instant-level risk is `DEPOSIT_LIMIT_CAPACITY` and the facilitator
bucket — the corridor, not a slice of it — and the remedy for a breach is unchanged: burn the
difference from treasury. Supersedes xchain#40.

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

**The emitter chain is pinned.** `MessageReceiver._onlyAuthorizedEmitter` compares against
`authorizedEmitters[chain]`, which is `bytes32(0)` for any unbound chain, so a zero-emitter VAA
matches the mapping default. Each PSM contract's `_processMessage` therefore refuses any
`emitterChainId` other than the one it is bound to. Fixed PSM-side deliberately: `MessageReceiver` is
shared with deployed basejump and oracle contracts.

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
| `INBOUND_CAPACITY` / `OUTBOUND_CAPACITY` | 10,000 / 24 h | Mint / redeem velocity. Outbound deliberately not tighter — this is the primary redemption route. |
| `REDEEM_FEE_BPS` | 5 | Redemption only; refunds and cancellations carry none. Capped at 500. |
| `SURPLUS_FLOOR_BPS` | 25 | Held back from the treasurer. |
| `MIN_USDC_PRICE` | $0.99 (8 dp) | Deposits refuse below it; redemption stays open. The whole mint gate, and fixed at init — there is no setter. |

## Deployment

```sh
FOUNDRY_PROFILE=psm pnpm --filter @whm/contracts build   # required — actions read out-psm/
pnpm migrate:psm-base:fork
pnpm migrate:psm-base
```

Nine steps: deploy both proxies, bind emitters (one-shot), set limits / fees, hand
`DEFAULT_ADMIN_ROLE` to its permanent holder and renounce the deployer's.

Two things the migration deliberately does **not** do, because neither is ours to run:

- `GhoToken.addFacilitator(facilitator, label, capacity)` — a Hydration technical-committee call.
  Until it lands the facilitator has a zero bucket and mints nothing.
- **Unpausing.** Both contracts ship paused. Redeem is unpaused first, then mint, once the bucket is
  granted and the invariant has been watched.

The PSM uses its own Foundry profile (`[profile.psm]`, via-IR, `out-psm/`) because `HollarBaseVault`
does not fit under EIP-170 unoptimised. The default profile is untouched so nothing already deployed
changes bytecode.

## Testing

```sh
FOUNDRY_PROFILE=psm forge test --match-path "test/psm/**"    # 120 tests
npx tsx chopsticks/probes/_probePsmRedeem.ts                 # the redeem leg, real runtime
```

Fork suites run against live chain state and skip cleanly without an RPC:

- `fork/BaseAaveFork` — real Aave v3.3, Circle USDC (including the blacklist), Chainlink USDC/USD.
- `fork/HydrationFacilitatorFork` — the real GHO contract's bucket arithmetic, mint and burn.

`transferFrom` on HOLLAR resolves its allowance through a Substrate runtime precompile that anvil
does not have, so the full redeem leg cannot run under Foundry — it is mocked in the fork suite and
exercised for real by the chopsticks probe.

## Contract reference

| Contract | Chain | Notes |
|---|---|---|
| `HollarBaseVault` | Base | UUPS. Reserve, Aave, FIFO queue, surplus. |
| `HollarBaseFacilitator` | Hydration | UUPS. GHO facilitator, mint queue, redeem. |
| `PsmPayload` | library | The 66-byte wire, one definition for both ends. |
| `RateLimiter` | library | Continuously-refilling budget; zero is closed, never unlimited. |
