# Relay Fee — paying the relayer on the destination

> Scope: the **Hydration / Moonbeam → out** direction only (today: → Ethereum). This is the leg
> where a relayer submits the final delivery transaction on the destination chain and must be paid
> for the gas it spends. Both the relay cost and the reimbursement are settled **on the destination
> chain, out of the bridged value** — never on the source. The relayer is only ever paid on a
> **successful** delivery.

There are two delivery paths out of Moonbeam, chosen by how fast the source finalizes:

|               | **WTT** (direct)                         | **BJP** (pooled)                                          |
| ------------- | ---------------------------------------- | --------------------------------------------------------- |
| When          | Source finalizes fast                    | Source finality slow                                      |
| Liquidity     | None — tokens delivered straight through | Pre-funded landing pool fronts, slow transfer replenishes |
| Messages      | **1** (TokenBridge payload-3)            | **2** (fast signal + slow TokenBridge replenish)          |
| Relayer trust | **Permissionless** market                | **Permissioned** (a trusted bot)                          |
| Fee model     | `maxRelayFee` ceiling in the payload     | Gated reimbursement from the pool                         |

The two paths need _different_ fee models, and the reason is the number of relayable messages —
explained at the end. Pick one model per path; don't mix them.

---

## WTT — permissionless relay market (`maxRelayFee`)

The WTT path is a single message: the swapped WETH is bridged through the Wormhole TokenBridge with
a payload (`transferTokensWithPayload`), and **any** relayer calls `redeem` on the destination
`IntentReceiver` to unwrap → native ETH → forward to the deposit address. Because anyone can relay,
the fee has to be **bounded and self-policing** — no relayer can over-charge, and an unprofitable
job simply goes unrelayed.

**The mechanism**

- The payload carries `(intentId, depositAddress, maxRelayFee)`. `maxRelayFee` is an
  ETH-denominated **ceiling** the user authorizes at emit time, sized from a gas estimate plus
  headroom. It rides inside the **guardian-signed VAA**, so it is authenticated end-to-end — no
  separate signed quote, no trusted signer, no source-chain call.
- The relayer names its own price: `redeem(vaa, feeRequested)`. The contract enforces
  `feeRequested ≤ maxRelayFee` and forwards `amount − feeRequested` to the deposit address, paying
  `feeRequested` (native ETH) to `msg.sender`.

**Why this is safe**

- **No on-chain floor needed.** The contract can't see gas cost, so the floor is the relayer's own
  choice: before submitting, it decodes `maxRelayFee` and `amount` from the VAA, estimates gas
  locally, and only relays if `maxRelayFee ≥ cost + margin`.
- **Competition drives the fee below the ceiling** when gas is cheap — relayers undercut on
  `feeRequested` rather than all grabbing the max.
- **A too-low `maxRelayFee` is a liveness issue, never a loss.** If it can't cover gas, nobody
  relays; the VAA just sits unredeemed (still valid, still replay-safe) until gas drops or it's
  retried with a higher ceiling. Funds are never at risk.

**Two relayer gotchas**

- It's **racy**: multiple relayers may decode the same VAA; the first `redeem` to land wins (the
  TokenBridge marks the VAA consumed) and the losers' txs revert. Margin must cover that revert
  risk. Run your own backstop relayer for liveness.
- The relayer must apply the **8-decimal Wormhole rescale** (`× 10^(decimals−8)` for 18-decimal
  WETH) when reading `amount`, or its profitability math is off.

**Sizing.** The contract can't see the OneClick `requiredDeposit`, so the UI sizes `amountIn` such
that `amount − maxRelayFee ≥ requiredDeposit`. There's no pool to decapitalize, so Wormhole dust
just lands in `amount` and is forwarded/fee'd normally — no buffer needed.

---

## BJP — trusted relayer (gated reimbursement from the pool)

The BJP path emits **two** messages: a **fast** signal (claimed via `completeTransfer`, paid out of
the pre-funded landing pool to beat slow finality) and a **slow** TokenBridge transfer that
replenishes the pool ~13 min later. Only the **fast** leg needs a fee model — and because it is a
_claim against pool liquidity_, not a token transfer, a permissionless fee here is exploitable (see
below). So BJP uses a **trusted bot** instead of an open market.

**The mechanism**

- Fast-path completion stays **callable by anyone** (so deliveries never stall on the bot), but the
  reimbursement is **gated**: the landing pays a fee only when the completer is on an
  `authorizedRelayer` allowlist.
  - Trusted bot calls it → recipient paid **+** bot reimbursed.
  - Anyone else calls it → recipient still paid, **no fee** (free completion / fallback).
- To reimburse, the fast-path completer (`completeTransfer`'s `msg.sender`) is **forwarded down to
  the landing** — `completeTransfer → _executeTransfer → BasejumpLanding.transfer(..., relayer)` —
  because that's where the pool liquidity lives.
- The fee is paid **from the pool's accrued `assetFee` margin**, and the recipient receives the
  **full `netAmount`**. The LP simply nets `assetFee − relayGas` instead of `assetFee`.

**Why a trusted bot, and what it buys**

- **No `maxRelayFee`, no payload change, no user knob.** The authenticated ceiling existed to bound
  an _untrusted_ relayer; a trusted bot doesn't need it. The source, the `TransferPayload`, and the
  intents sizing checklist are all unchanged.
- **Bounded blast radius** instead of an authenticated ceiling: the landing carries a configurable
  `relayCap`, so a leaked bot key can't drain the pool with one inflated reimbursement.
- **The slow leg stays permissionless.** The slow TokenBridge transfer is addressed to the pool, so
  whoever redeems it, the tokens always credit the pool — the operator (who runs both the pool and
  the bot) is motivated to replenish, and no third party can interfere.

---

## Why the two paths can't share one model

The danger on a pooled path is **cherry-picking**: if the fast leg pays a fee but the slow leg
doesn't, a permissionless relayer relays only the profitable fast leg (collecting the fee, draining
the pool) and ignores the slow replenishment, shifting that gas onto the LP and risking the pool
running dry. (It's never _theft_ — the slow tokens always reach the pool when anyone redeems them —
but it's a real economic/liveness misalignment.)

Two ways out: incentivize **both** legs, or make the fast leg **permissioned**. BJP takes the second
— a trusted bot has no incentive to cherry-pick, so the slow leg can safely stay open.

**WTT has none of this**: a single message both delivers to the recipient _and_ pays its redeemer.
There's no second leg to skip and no pool to drain, so the fee can be fully permissionless and
self-policing via `maxRelayFee`. That's exactly why WTT is preferred wherever source finality is
fast enough to skip the pool.

---

## Contract surface (summary)

**WTT** (intents-local):

- `IntentReceiver` — `redeem(vaa, feeRequested)`; decode the 96-byte payload, enforce
  `feeRequested ≤ maxRelayFee`, pay `msg.sender`, forward the rest.
- `IIntentReceiver` — updated `redeem` signature + fee event/error.
- `IntentEmitterWtt` — encode `maxRelayFee` into the TokenBridge payload (96 bytes).

**BJP** (shared BasejumpCore infra):

- `BasejumpCore` — forward `completeTransfer`'s caller through `_processMessage` / `_executeTransfer`.
- `IBasejumpLanding` — add the `relayer` arg to `transfer`.
- `BasejumpLandingNative` — `authorizedRelayer` allowlist + `relayCap`; gated reimbursement from the
  pool; recipient still receives full `netAmount`.
- `BasejumpLanding` (Hydration/XCM variant) — inherits the new arg and **ignores it** (no EVM payee).
- `IntentEmitterBjp`, `IntentRouter`, the payload format — **unchanged**.

All affected contracts are UUPS-upgradeable; every change above is logic-only or append-only storage
(`authorizedRelayer`, `relayCap`) — no storage reordering.
