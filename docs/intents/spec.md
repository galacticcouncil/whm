# SPEC — Intents: Hydration → NEAR Intents (1Click)

Hydration users acquire any NEAR-Intents-supported asset (BTC, ZEC, NEAR, …). Their asset is sold for
WETH on Hydration, settled to Ethereum over NTT, and forwarded into a **1Click deposit address** that
NEAR Intents credits. Deployed and running.

A user is present. They ask 1Click for a quote, the quote mints a deposit address, and that address
survives exactly one swap. Everything the user needs to check is in front of them at quote time — the
destination, the rate, the expiry — so the design needs no on-chain authorization. The contracts never
learn where the address came from: `depositAddress` is just an address.

```solidity
placeOrder(assetIn, amountIn, minEthOut, depositAddress, maxRelayFee)
```

Wire formats: [schema.md](schema.md). Relay fee model: [relay-fee.md](relay-fee.md). Refunds:
[refund.md](refund.md). What has been checked live: [verification.md](verification.md).

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
the user authorizes it by signing the transaction that pays into it. That is the check: nothing
on-chain validates the destination.

**What it cannot do.** Run unattended. The quote expires, the rate is frozen inside it, and getting a
new one needs an HTTP call in the critical path.

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
all three deposit modes. Nothing can re-derive one, which is why a schedule cannot reuse it.

**`refundTo` is an Ethereum address**, because `refundType: ORIGIN_CHAIN` returns the origin asset,
and the origin asset here is native ETH on Ethereum. If the user's identity on Hydration is an H160,
the same value works — but the refunded funds exist on Ethereum. See §6.

---

## Shared transport

Two Wormhole messages leave the same Hydration transaction, because NTT carries no payload of its own
— the destination has to travel separately.

```
HYDRATION   IntentEmitter.placeOrder(assetIn, amountIn, minEthOut, depositAddress, maxRelayFee)
              1. sell assetIn → WETH via the router   (no-op when assetIn is already WETH)
              2. deduct cost = NTT deliveryPrice + wormhole messageFee, from the swap output
              3. quantize to TRIM_UNIT (1e10) — NTT trims to 8dp, WETH is 18dp
              4. nttManager.transfer(amount, 2, IntentReceiver)   → transferSequence
              5. wormhole.publishMessage(abi.encode(
                     transferSequence, depositAddress, maxRelayFee), consistency 202)
              → emits OrderPlaced

ETHEREUM    IntentReceiver.processOrder(nttVaa, instructionVaa, feeRequested)
              1. verify the instruction (guardian quorum, emitter pinned to chain 73 + address)
              2. require instruction.sequence == settlement's NTT manager sequence
              3. read the amount off the settlement, at the rail's own precision
              4. require feeRequested <= maxRelayFee
              5. deliver the settlement through the transceiver, unless already delivered
              6. forward (amount - feeRequested) to depositAddress; pay the caller its fee
              → emits OrderProcessed, RelayFeePaid
```

**Why two messages and not one.** The Wormhole TokenBridge's `transferTokensWithPayload` carries a
payload _and_ restricts redemption to the named recipient. NTT does neither in any way we can reach:
`receiveMessage` is permissionless, and while `NativeTokenTransfer` does have an `additionalPayload`
field, nothing populates it from a caller — `_prepareNativeTokenTransfer` hardcodes `""` and both it
and the inbound `_handleAdditionalPayload` are `internal virtual` hooks, so using it means custom
manager subclasses on **both** chains. So the destination rides its own message, and the two are
bound by the **NTT manager's sequence** — not a Wormhole sequence, and not chain-global. Pairing a
settlement with someone else's instruction fails that check.

**Why the instruction publishes finalized.** That sequence is contract storage, so a reorg rewinds
it. Published instantly the instruction would be signed before the block was final and stay valid
forever, pointing at whatever transfer next took that counter. Finality costs nothing here: the settlement leg
is 202 regardless and a relayer cannot act until it arrives, which measurement confirms is ~38s
after the instruction used to be available.

**Why the amount is not carried.** It rides in the settlement, so the receiver reads what actually
released rather than what an instruction claimed. There is then no divergence to check for and no
aggregate-balance test to get wrong — the number the receiver forwards is the number the rail
delivered.

**Why delivery is atomic with the forward.** Because NTT delivery is permissionless, a generic
relayer can deliver a settlement before we do — funds would then sit in the receiver with nothing to
move them. `processOrder` handles both cases in one call: it delivers if needed, then forwards. Since
the caller does all of it, the caller is the one paid, so there is nothing to snipe.

**Why the fee ceiling is a caller argument.** `maxRelayFee` is committed per order rather than set by
an operator. Paired with a colluding relayer, a ceiling is a claim on the order's value, so it
belongs to whoever's funds are at risk. A scheduler stores it alongside `depositAddress`, so placing
an order still needs nothing off-chain.

**Not payable.** Both fees come out of the swap output, which works only because Hydration's native
currency _is_ WETH — one balance behind two interfaces. That is what lets an on-chain scheduler place
an order with no funding step.

---

## 3. Hydration

`placeOrder` sells the user's asset for WETH through the router, deducts the NTT delivery price and
the Wormhole message fee out of the swap output, quantizes to `TRIM_UNIT`, settles over NTT to
`IntentReceiver`, and publishes the forwarding instruction beside it — the shared transport above.

---

## 4. Ethereum — delivery and the fee

[`agents/relayer`](../../agents/relayer/)'s `intent` app subscribes to the Hydration WETH
transceiver, finds the instruction in the source transaction's `LogMessagePublished` logs, prices the
fee by estimating the real call, and submits `processOrder`. Retries ride the relayer engine's
Redis-backed backoff; an order stale beyond the age cap is dropped rather than retried forever.

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
issued. Nothing of ours runs on NEAR.

> **The POA step is not a transaction we build.** The deposit address is POA's; sending native ETH
> there _is_ the deposit into NEAR Intents, and POA's off-chain watcher does the crediting. You deliver
> native ETH on Ethereum; the tradeable claim exists on NEAR as `nep141:eth.omft.near`
> (`defuse_asset_identifier: eth:1:native`). The ETH stays custodied on Ethereum — ordinary
> lock-and-mint.

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
signing for it. The user reading the quote is the whole control.

**The quote expires.** A slow relay can outlive it. Funds are not lost — 1Click refunds the origin
asset — but the swap does not happen and the user pays the round trip.

**A too-low `maxRelayFee` stalls rather than loses.** No relayer submits, the VAA sits valid and
replay-safe, and the order retries with backoff until gas falls.

---

## 8. Status

Deployed and running: `IntentEmitter` and `IntentReceiver` on their proxies,
[`agents/relayer`](../../agents/relayer/)'s `intent` app, [`agents/intent`](../../agents/intent/)'s
quoter and relayer apps, and [`agents/scan`](../../agents/scan/)'s `intents` app. Addresses:
[`deployments/prod/intent.json`](../../deployments/prod/intent.json).

Verified against the live system ([verification.md](verification.md)):

- Deposit addresses are non-deterministic across all three deposit modes, and `ANY_INPUT` rejects
  `ORIGIN_CHAIN` outright.
- Native ETH on `eth:1` maps to `nep141:eth.omft.near` with a `1e11` wei minimum deposit.
- 1Click quotes ETH → ZEC at production size, to **transparent** ZEC addresses. `t1` and `t3` both
  work; `zs1` and `u1` are rejected, so a Zcash destination is a public address.
