# PHASE 1 — Attended intents (1Click)

A user is present. They ask 1Click for a quote, the quote mints a deposit address, and that address
survives exactly one swap. This is what is deployed and running today.

Everything the user needs to check is in front of them at quote time — the destination, the rate, the
expiry — so the design needs no on-chain authorization and no derived account. The contracts never
learn where the address came from: `depositAddress` is just an address.

Everything up to and including the Ethereum forward is shared with [Phase 2](phase2.md) — see
[spec.md](spec.md#shared-transport). This document covers the parts that are specific to the attended
variant.

---

## 1. From the user's side

```
 PER SWAP                                        user present, one signature
   ├─ SDK requests a 1Click quote                §2
   │    → depositAddress, amountOut, deadline
   ├─ SDK sizes maxRelayFee from the quoter      §4
   ├─ user sees destination, rate and expiry, and signs
   │
   ├─ HYDRATION   placeOrder → sell, settle over NTT, publish the instruction   §3
   ├─ ETHEREUM    relayer delivers, forwards native ETH to depositAddress       §4
   ├─ POA         credits the quote's intents account
   ├─ NEAR        1Click's solver network fills the quote                       §5
   └─ DEST CHAIN  the asset arrives at the user's address
```

Hydration → Ethereum is about a minute. Everything after that is 1Click's — POA crediting, then a
solver taking the quote.

**What the user is trusting.** The quote itself. `depositAddress` comes from 1Click over HTTP, and
the user authorizes it by signing the transaction that pays into it. That is the check, and it is why
the variant needs a user: nothing on-chain validates the destination.

**What it cannot do.** Run unattended. The quote expires, the rate is frozen inside it, and getting a
new one needs an HTTP call in the critical path. That is what [Phase 2](phase2.md) exists for.

---

## 2. SDK — getting the deposit address

One call, per swap, before the user signs.

```
OneClickService.getQuote({
    originAsset:      "nep141:eth.omft.near",     ← native ETH on Ethereum, what we deliver
    destinationAsset: "nep141:zec.omft.near",
    recipient:        "<the user's destination address>",
    refundType:       "ORIGIN_CHAIN",
    refundTo:         "<the user's Ethereum H160>",
    …amount, slippage, deadline
})
  → depositAddress, amountOut, deadline
```

`originAsset` is always native ETH on Ethereum, because that is what `IntentReceiver` forwards. The
`nep141:` prefix denotes the token standard, not where you deposit — `nep141:eth.omft.near` is
`blockchain: "eth"` and is delivered on Ethereum, unlike `nep141:eth.bridge.near`.

**Deposit addresses are non-deterministic.** Byte-identical requests return different addresses, in
all three deposit modes. Nothing can re-derive one, which is why a schedule cannot reuse it and why
Phase 2 derives its own instead.

**`refundTo` is an Ethereum address**, because `refundType: ORIGIN_CHAIN` returns the origin asset,
and the origin asset here is native ETH on Ethereum. If the user's identity on Hydration is an H160,
the same value works — but the refunded funds exist on Ethereum. See §6.

---

## 3. Hydration

```solidity
placeOrder(assetIn, amountIn, minEthOut, depositAddress, maxRelayFee)
```

Sells the user's asset for WETH through the router, deducts the NTT delivery price and the Wormhole
message fee out of the swap output, quantizes to `TRIM_UNIT`, settles over NTT to `IntentReceiver`,
and publishes the forwarding instruction beside it. Full mechanics in
[spec.md](spec.md#shared-transport).

Not payable — both fees come out of the swap output, which works because Hydration's native currency
is WETH.

---

## 4. Ethereum — delivery and the fee

[`agents/relayer`](../../agents/relayer/)'s `intent` app subscribes to the Hydration WETH
transceiver, finds the instruction in the source transaction's `LogMessagePublished` logs, prices the
fee by estimating the real call, and submits:

```solidity
IntentReceiver.processOrder(nttVaa, instructionVaa, feeRequested)
```

One call delivers the settlement, forwards `amount - feeRequested` to `depositAddress`, and pays the
caller. Atomic, so whoever does the work is the one paid and there is nothing to snipe.

**`maxRelayFee` is sized before either VAA exists**, so it is a forecast — the SDK asks
[`agents/intent`](../../agents/intent/)'s quoter, which models the call from its calldata envelope
and prices at `maxFeePerGas`. Model and measurements: [relay-fee.md](relay-fee.md).

**Relaying is a race.** Several relayers may build the same call and the first to land wins; losers
revert and eat the gas. An `authorizedRelayer` allowlist grants a five-minute exclusivity window from
the settlement's timestamp before the call opens to anyone — a liveness and MEV control, not a fee
surface. While the allowlist is empty, processing is permissionless.

---

## 5. NEAR — 1Click settles it

POA credits the quote's intents account, and 1Click's solver network fills the quote it already
issued. Nothing of ours runs on NEAR in this variant.

The one thing we do is make sure the deposit is noticed promptly.
[`agents/intent`](../../agents/intent/)'s relayer app watches `IntentReceiver.OrderProcessed` over
`eth_subscribe` and calls 1Click's `submitDepositTx(depositAddress, txHash)` for each forward, deduped
by `(txHash, depositAddress)`. Without it an order can sit until 1Click's own watcher notices.

[`agents/scan`](../../agents/scan/)'s `intents` app indexes the whole path — `OrderPlaced` →
`OrderProcessed` → the 1Click execution status — into `placed / processed / settled / refunded /
failed`, joined on `depositAddress`, with the raw 1Click status kept verbatim so an unmapped one is
still visible.

---

## 6. Refunds

A quote that does not complete refunds the **origin asset on the origin chain** — native ETH on
Ethereum — to `refundTo`. The recommended value is the user's own Ethereum H160.

**Never the bridge contracts.** `IntentReceiver` is not intent-aware and holds no liquidity in the
happy path; a stray inbound transfer has nothing to act on. Refund accounting stays out of the bridge.

A refunded order shows in `scan` as `refunded` with `refund_amount`, `refund_reason` and the origin
transaction, distinct from a settled one — the quoted amount is not the delivered amount, and an
order that refunded never delivered anything.

Full model: [refund.md](refund.md).

> **Stale section.** [refund.md](refund.md)'s "Key Assumption" still describes the WTT path — WETH
> bridged Hydration → Moonbeam → Ethereum over the Wormhole TokenBridge. The deployed path is NTT,
> direct from Hydration. The refund conclusions hold; the transport description does not.

---

## 7. Residual

**The destination is only as good as the quote.** Nothing on-chain checks `depositAddress`, so a
compromised SDK or a hostile quote endpoint could name a different destination and the user would be
signing for it. The user reading the quote is the whole control — which is exactly why the unattended
case needs a different design.

**The quote expires.** A slow relay can outlive it. Funds are not lost — 1Click refunds the origin
asset — but the swap does not happen and the user pays the round trip.

**A too-low `maxRelayFee` stalls rather than loses.** No relayer submits, the VAA sits valid and
replay-safe, and the order retries with backoff until gas falls.

---

## 8. Status

Deployed and running: `IntentEmitter` and `IntentReceiver` on their proxies,
[`agents/relayer`](../../agents/relayer/)'s `intent` app, [`agents/intent`](../../agents/intent/)'s
quoter and relayer apps, and [`agents/scan`](../../agents/scan/)'s `intents` app.

Verified against the live system, with the rest grouped by status in
[verification.md](verification.md):

- Deposit addresses are non-deterministic across all three deposit modes, and `ANY_INPUT` rejects
  `ORIGIN_CHAIN` outright — both are what rule the 1Click path out for DCA.
- Native ETH on `eth:1` maps to `nep141:eth.omft.near` with a `1e11` wei minimum deposit.
- 1Click quotes ETH → ZEC at production size, to **transparent** ZEC addresses. `t1` and `t3` both
  work; `zs1` and `u1` are rejected, so a Zcash destination is a public address.
