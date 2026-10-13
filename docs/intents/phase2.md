# PHASE 2 — Unattended intents

Phase 1 is the 1Click variant: a user is present, they request a quote, the quote mints a deposit
address, and that address survives one swap. It is live and nothing here changes it.

Phase 2 removes the user from the loop. A DCA schedule fires for weeks without anyone watching, so
the deposit address has to be permanent and the price has to come from somewhere that cannot be
influenced by whoever is relaying. Two things follow, and they are the whole design:

- **The address is derived, once**, from terms the user signs at schedule creation. Guardians sign
  those terms; NEAR re-derives the account from them. Nothing off-chain picks where funds go.
- **The price is read on Hydration**, from a price oracle, in the same transaction that fires the
  tranche, and published inside the guardian-signed quote. Nothing off-chain picks the rate either.

Everything up to and including the Ethereum forward is shared with Phase 1 — see
[spec.md](spec.md#shared-transport). This document covers what happens on either side of it.

---

## 1. From the user's side

```
 ONCE, at schedule creation                      user present, one signature
   ├─ pick asset, amount, cadence, destination asset, recipient
   ├─ SDK derives the deposit address            §2
   ├─ user checks `recipient`                    the only value they need to verify
   └─ DCA/SWAP schedule created on Hydration

 EVERY TRANCHE                                   nobody present, no HTTP, no keys
   ├─ HYDRATION   dispatch → sell, settle over NTT, publish the priced quote      §3
   ├─ ETHEREUM    relayer delivers, forwards native ETH to 0xN       (Phase 1 path, unchanged)
   ├─ POA         credits NEAR account A with nep141:eth.omft.near   (not our transaction)
   ├─ NEAR        bot calls finalize(vaa); router signs the swap     §5
   └─ ZCASH       ZEC arrives at `recipient`
```

Hydration → Ethereum is about a minute — the Wormhole leg is not the bottleneck. Everything after it
is: POA crediting `A`, then `finalize`, the MPC signature, and a solver taking the order. None of
those is measured yet, and MPC signing latency is open in [verification.md](verification.md).

**What the user is trusting.** `recipient` is read from guardian-signed bytes on every call, so a
fully compromised bot cannot redirect funds, cannot forge a VAA, and cannot ask the MPC for a
signature — only the router's code can, and only over a payload built from a verified VAA. The price
is computed on Hydration and travels in the same signed bytes. The amount is read from the account's
balance. There is no number in the flow that an off-chain party supplies.

**What it gives up.** The intent is a posted limit order at the oracle floor, so whatever the market
would have paid above that floor goes to the solver. See §7.

**What happens when nothing fills.** The balance sits in `A`. Nothing expires, nothing is lost, and
the next tranche's quote picks it up. See §6.

---

## 2. SDK — deriving the deposit address

Three reads, no transactions, before the user is asked to sign anything. This is the only part of
the system that touches an off-chain service, and it happens exactly once per schedule.

```
1. authPath = keccak256(IntentCodec.encodeQuote(terms))
     terms = { quoteId, maxSlippageBps, recipientKind, destinationAsset, recipient }
     available on-chain as IntentQuoteEmitter.computeAuthPath(terms), and mirrored off-chain

2. NEAR  v1.signer.derived_public_key({
             predecessor: "intents-router.hydration.near",
             path:        authPath,
             domain_id:   1                      // 1 = Ed25519
         })
       → ed25519:2kbv31BMDHBK54RYMX1gKiSLCXMjWphF9sbxvH4o4D3S
       → A = lowercase hex of the 32 decoded bytes     ← NEAR implicit account, self-registering

3. POA   deposit_address({ account_id: A, chain: "eth:1" })
       → 0xN                                            ← what placeOrder is given
```

Then show the user `recipient`, `A` and `0xN`, and take **one** signature creating the DCA schedule
with `0xN` and `maxRelayFee` stored in it.

**Only `recipient` needs checking.** Every other value is derived from it, so a wrong `A` or `0xN` is
unreachable without a wrong `recipient` — and the user is looking at the address their funds will
land on.

**Why this cannot be on-chain.** Step 2 needs Ed25519 point arithmetic, which the EVM has no
precompile for. Step 3 is POA's own derivation — the address has no code and is not a hash of the
account id in any encoding, so there is nothing to reimplement. It does not matter: this is once per
schedule, and every tranche afterwards is fully on-chain.

**Derivation is public but authority is not.** Anyone can compute anyone's derived key —
`derived_public_key` is a public view. When the router calls `sign`, the MPC network takes the
predecessor from the runtime's true caller, so there is no field to lie in. See
[spec.md §3](spec.md#3-key-derivation-and-the-constant-address).

**One address per schedule, reused for every tranche.** Balances merge in `A`, which is what makes
the drain idempotent.

---

## 3. Hydration — one call per tranche

`IntentDispatcher` is stateless. Hydration's DCA pallet already holds the schedule — asset, amount,
interval, next run — so the dispatcher stores nothing and guards nothing; it composes two existing
contracts in one transaction.

```solidity
function dispatch(
    uint32 assetIn, uint256 amountIn, uint256 minEthOut,
    address depositAddress, uint256 maxRelayFee, Quote memory q
) external payable {
    IERC20 t = IERC20(HydrationConsts.toErc20(assetIn));
    t.safeTransferFrom(msg.sender, address(this), amountIn);
    t.forceApprove(address(intentEmitter), amountIn);

    (, uint256 bridgeAmount) =
        intentEmitter.placeOrder(assetIn, amountIn, minEthOut, depositAddress, maxRelayFee);

    q.amountIn = bridgeAmount;                        // the cap, only knowable after the swap
    quoteEmitter.publishQuote{value: msg.value}(q);   // reads the oracle, writes minOutPerIn
}
```

Permissionless, for the same reason `placeOrder` already is: it spends only `msg.sender`'s funds, so
a caller passing a bogus `depositAddress` misdirects their own money and nobody else's.

The two legs leave as separate Wormhole messages from separate emitter addresses — the instruction
from `IntentEmitter`, the quote from `IntentQuoteEmitter` — so `IntentReceiver` still rejects a quote
VAA as `UnauthorizedEmitter` before anything decodes it. `IntentReceiver` is untouched.

### The one change to `IntentEmitter`

```solidity
function placeOrder(…) external returns (uint64 transferSequence, uint256 bridgeAmount)
```

`bridgeAmount` is already a local and already in `OrderPlaced`, but a contract cannot read its own
logs — to reach `publishQuote` in the same transaction it has to be returned. Deployed behind a UUPS
proxy, so the upgrade preserves the address and therefore the Wormhole emitter address and sequence.
No storage is added, so the layout is untouched.

### `IntentQuoteEmitter` reads the oracle

```
minOutPerIn = (base / quote) × DEST_SCALE × (1 - maxSlippageBps)
```

`base` and `quote` come from `AggregatorV3.latestRoundData()` on Hydration — ETH/USD as the
numerator, since the input is always `nep141:eth.omft.near`, and DEST/USD as the denominator. Both
are rejected if `updatedAt` is beyond the configured age. `DEST_SCALE` is the destination's decimals:
ZEC has 8, so 3.0154 ZEC/ETH encodes as `301_540_000`, destination smallest-units per `1e18` of input.

**The oracle pair is looked up from `destinationAsset`, not passed in.** `publishQuote` stays
permissionless — "publishing someone else's terms derives _their_ account and can only pay _them_" —
and that only holds while no pricing input comes from the caller. An owner-configured registry maps
`destinationAsset → (baseAssetId, quoteAssetId)`.

`amountIn` is a caller argument and safely so: it is a cap on consumption, not a price. Too large
means "consume whatever is available", which is the behaviour without it; too small under-consumes
and self-corrects on the next tranche.

---

## 4. Oracle feeds

The rail already exists and is in production — [`agents/relayer`](../../agents/relayer/)'s `oracle`
app relays `OracleEmitter` VAAs into per-source `OracleReceiver` deployments on Hydration, which
verify the emitter, reject stale updates, and push the price into the Hydration oracle.

What is missing is feeds for ZEC, NEAR and the rest. Those come from Pyth, read on **Ethereum**,
where `OracleEmitter` already has a relayer route:

```solidity
/// Reads one Pyth feed and returns it at 18 decimals, the convention the oracle rail carries.
contract PythAdapter {
    function price(bytes32 feedId) external view returns (uint256) {
        PythStructs.Price memory p = pyth.getPriceNoOlderThan(feedId, maxAge);
        int64 conservative = p.price - int64(p.conf);   // bias low: an optimistic floor never fills
        require(conservative > 0, "price underwater");
        return _to18(uint64(conservative), p.expo);
    }
}
```

One `registerFeed(assetId, pythAdapter, abi.encodeCall(price, (feedId)))` per asset and the feed
rides a rail that is already running — no new chain, no new receiver, no new relayer route.

**Not a Pythnet receiver.** Pyth broadcasts over Wormhole from chain 26, but its accumulator VAA
carries a merkle root; a specific feed's price needs a proof fetched from Hermes off-chain, so
`receiveMessage(vaa)` cannot decode one.

**Cadence is a configuration decision, not a code one.** The broadcaster publishes on a change
threshold (0.1% default) with a 24h fallback, which is right for a slow rate like wstETH and wrong
for a volatile spot pair. A floor already carries `maxSlippageBps` of headroom, so setting the
threshold well inside that band bounds the error by construction and keeps the push rate low.

---

## 5. NEAR — `finalize(vaa)`

One argument. Every number comes from the VAA or from a balance read.

```
finalize(vaa)
  1. verify           guardian quorum, emitter chain 73 + IntentQuoteEmitter's address
  2. decode           path := keccak256(identity prefix)
                      amountIn, minOutPerIn := the per-tranche tail
  3. require fresh    block_timestamp - vaa.timestamp <= MAX_QUOTE_AGE
  4. require unused   one quote VAA, one fill
  5. read balance     mt_batch_balance_of(A, "nep141:eth.omft.near")        [promise]

on_balance:
  6. require balance > 0
  7. amount_in  := min(amountIn, balance)
     amount_out := amount_in × minOutPerIn / 1e18
  8. nonce := sha256(path ‖ counter)
  9. build the NEP-413 message
       token_diff   -amount_in / +amount_out
       ft_withdraw  to `recipient` — read from the VAA, never an argument
 10. v1.signer.sign({ payload, path, domain_id: 1 })                        [promise]

on_signed:
 11. mark the VAA used, store the MultiPayload, emit intent_signed
```

Step 3 is the guard doing the real work. Without it, a quote from last month verifies exactly as well
as one from this minute and the floor is decorative. Step 4 is what makes the cap meaningful — one
quote authorizes one fill of at most `amountIn`.

The bot then publishes `publish_intent([], signed_data)` and polls `get_status` until settled. There
is no `quote_hash`, because there is no solver quote — the price came from the chain.

**Keep the intent's `deadline` short.** Two reasons pull the same way. A signed intent valid for `T`
is an option written to solvers, and its time premium scales with `√T` — a 60-minute window costs
roughly 7–8× a 60-second one. And an unfilled payload stays live until its deadline, so if it outlives
the tranche interval it becomes a stale-rate claim on the *next* tranche's deposit. Minutes against a
day leaves enormous margin, but the invariant is `deadline < tranche interval`.

---

## 6. Accumulation

If a tranche does not fill, its ETH stays in `A` and the next tranche's deposit lands beside it.
Without a cap the next `finalize` would swap the whole pile at once, which is not DCA.

`amountIn` is what prevents that. Each quote authorizes at most one tranche's worth:

```
one tranche pending      balance < cap    →  consumes the balance, sweeps clean, no dust
three tranches pending   balance > cap    →  consumes ~one tranche at the current rate
```

The cap is `bridgeAmount`, an **upper** bound on what lands — the actual credit is
`bridgeAmount - feeRequested` and the relayer's fee is always at or under its ceiling. That is why
the normal case sweeps clean instead of leaving dust behind on every tranche.

A backlog therefore drains one tranche per subsequent tranche rather than all at once. Stale quotes
expire unused under the freshness check in §5, so nothing ever fills at an old rate.

**Repeated non-fills are a signal, not a steady state.** A non-fill means the market sat below
`oracle × (1 - slippage)`, which is a dislocation or a stale feed. The bot should alert when the
balance exceeds a few tranches, and the schedule should be pausable — continuing to buy into a
feed that is wrong is worse than stopping.

---

## 7. Residual

**The surplus above the floor goes to the solver.** The intent is a limit order at exactly
`amount_out`; whatever the market would have paid above it is the filler's. The oracle bounds the
loss, it does not compete for the gain. Recovering it needs discovery rather than a reference —
[dutch-auction.md](dutch-auction.md), and the two compose, since a per-tranche oracle price is
exactly the anchor a ladder's `startRate` needs. Comparison of the options:
[price-integrity.md](price-integrity.md).

**A compromised bot can stall.** It cannot redirect, misprice or mis-size. `finalize` is
permissionless, so anyone — including the user — can push it, which makes withholding weak
censorship rather than a denial.

**There is no exit.** Funds in `A` can only ever be spent to `recipient` as `destinationAsset`. If a
pair becomes permanently unfillable the balance is stranded, because `recipient` is an address in the
destination asset and no field carries a refund destination. The additive fix is a `refundTo` in the
path-committed terms plus a withdraw-only signing path — gated on the same VAA verification as
`finalize`, never on an owner, per [spec.md §3](spec.md#the-invariant-that-carries-the-whole-design).
Not designed yet, and it should be before the first schedule holds real value.

---

## 8. What has to be verified

Blocking, in order:

- **Solvers fill an unmatched intent.** `publish_intent` accepts `quote_hashes: []`, but whether
  solvers actually take a limit order posted to the book is untested. The whole flow is a posted
  limit order.
- **The exact bytes signed under `nep413`.** A wrong guess is a silent total failure — signatures
  produced and rejected with nothing indicating which field diverged. See [schema.md](schema.md) §4.
- **The router account id is registered and controlled by us.** Permanent, and every derived account
  depends on it.
- **Pyth has ZEC/USD and NEAR/USD reachable on Ethereum, and something keeps them fresh.** Decides
  whether §4 is trivial or expensive.

The full list, grouped by status, is [verification.md](verification.md).
