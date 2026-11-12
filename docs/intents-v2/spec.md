# SPEC — Intents v2: unattended swaps and DCA

v2 runs a swap or a whole DCA schedule with nobody present. Each **action** gets one NEAR account `A`,
derived by MPC from the action's terms, and one reusable POA deposit address `0xN` for it. Every
execution bridges ETH into `A` with its own oracle price; the NEAR router signs `A`'s swap, delivery
or refund, and only ever by the terms.

```
HYDRATION  ICE trade → WETH → IntentDispatcher ─┬─ NTT transfer + forward payload ─► ETHEREUM IntentForwarder ─► ETH → 0xN
                                                │                                                              POA credits A
                                                └─ order message (price) ─────────────────────────────► NEAR IntentRouter
                                                                                                         swap · deliver · refund
```

| | v1 (deployed) | v2 |
| --- | --- | --- |
| Entry on Hydration | user calls `IntentEmitter.placeOrder` | ICE `OnResolved::Forward` → `IntentDispatcher.execute`, or `IntentDispatcher.dispatch` |
| Rail | NTT transfer + a separate instruction VAA → `IntentReceiver` | one NTT transfer carrying the forward payload → `IntentForwarder` |
| `depositAddress` | 1Click's, random per quote | POA's `0xN` for `A`, derived from the terms, reused by every order |
| Who triggers the swap | 1Click, on deposit | a bot → `IntentRouter.swap(terms, orderVaa, quote)` → MPC signs for `A` |
| Price | 1Click quote, user present | 1Click quote per order, floored by the order's oracle rate |
| Refund | 1Click, to `refundTo` | the router, ETH to `refundTo` after the deadline |

Three things make it work unattended:

- **The router owns the deposit address.** Only it can obtain a signature for `A`, and `A` is
  derived from the terms, so the router stores nothing per action and can only spend `A` by them.
- **Every order carries its own price.** The dispatcher prices each execution from Hydration feeds
  and publishes it with the order. 1Click quotes the swap; the router signs only a quote at or above
  that order's floor.
- **The destination travels inside the transfer.** The NTT transfer's payload says where its ETH
  goes, attested with the transfer itself — one VAA, nothing to pair.

### The strategy

A strategy is what the router does with `A`'s ETH. The terms are its parameters; hashing them into
`A` makes one strategy instance one account. One action — a swap, or a whole DCA schedule — has one
`A` and one `0xN`, reused by every order.

| Strategy | Does |
| --- | --- |
| **Limit swap** (terms version 1, this spec) | swap `A`'s ETH through a 1Click quote at ≥ `outPerIn × (1 − slippage)`; deliver; refund after the deadline |
| Later | Dutch auction ([dutch-auction.md](dutch-auction.md)), other destination kinds |

- **The terms' version byte selects the strategy.** A new strategy is a new terms version: it
  derives disjoint accounts and changes nothing on Hydration or Ethereum.
- **Swap and DCA are the same strategy.** The router does not tell them apart: it swaps what `A`
  holds at the price of the order it is given. The difference lives on Hydration — ICE fires one order
  for a swap, N for a DCA.

Data formats: [schema.md](schema.md). Build status and gates: [plan.md](plan.md).

| Component | Chain | Role |
| --- | --- | --- |
| `IntentDispatcher` | Hydration | ICE callback and direct entry; prices, bridges, publishes the order. UUPS proxy: ICE intents, the forwarder and the router pin its address |
| `NttManagerWithPayload` (WETH) | Hydration | the WETH NTT manager, upgraded to carry a transfer payload |
| `IntentForwarder` | Ethereum | delivers the NTT transfer, pays the relayer, forwards the rest to `0xN` |
| `IntentRouter` | NEAR | stateless, DAO-upgradeable; terms + order + quote → signed intent for `A` |
| Bot | off-chain | NEAR gas key only: quotes 1Click, calls the router, publishes what it signs |
| Relayer | off-chain | calls `processOrder` on Ethereum, paid from the order's relay ceiling |
| Price feeds | Hydration | DIA `AggregatorV3` feeds: ETH/USD and each destination asset's USD price |

**Guarantees.** Funds in `A` only ever go to a 1Click swap that pays and refunds `A`, to `recipient`
(as `destinationAsset`), or to `refundTo`. No fill below `outPerIn × (1 − maxSlippageBps)` or the
hard floor. One fill per order. Only the terms' owner places their orders. No number comes from the
bot. A stale feed bridges nothing. **Not guaranteed:** the best market price; a price fresher than
`maxFeedAge` during a feed outage; automatic retry of a failed ICE callback; refunds on Hydration
(they arrive as ETH on Ethereum).

---

## 1. From the user's side

```
 ONCE, at creation                               user present, one signature
   ├─ pick asset, amount, cadence, destination asset, recipient, refund address
   ├─ SDK builds the terms and derives A → 0xN   §2
   ├─ user checks `recipient` and `refundTo`
   └─ ICE swap or DCA intent created on Hydration, forwarding to IntentDispatcher

 EVERY EXECUTION                                 nobody present
   ├─ HYDRATION   ICE trades asset → WETH; dispatcher prices, bridges, publishes the order   §3
   ├─ ETHEREUM    a relayer calls processOrder: ETH → 0xN                                    §5
   ├─ POA         credits A with nep141:eth.omft.near                   (not our transaction)
   ├─ NEAR        bot quotes 1Click, router signs A's swap; later the delivery               §6
   └─ DESTINATION the asset arrives at `recipient`
```

**What the user is trusting.** `owner`, `recipient` and `refundTo` are inside the terms, and the
terms derive `A` — nothing can spend `A` anywhere else, and nobody but the owner can place its
orders. The price comes from the order message, the amount from `A`'s balance, the swap from a quote
1Click signed. No number in the flow is supplied by the bot.

**What happens when nothing fills.** The ETH waits in `A`. The next order buys it; after the
deadline it is refunded (§7).

---

## 2. SDK — terms and the deposit address

### Terms

One set per action, all hashed into the account:

| Field | Meaning |
| --- | --- |
| `owner` | the user's Hydration EVM address — what ICE calls the dispatcher as; the only caller its orders are taken from |
| `quoteId` | random 32 bytes — keeps the user's actions on separate accounts |
| `maxSlippageBps` | floor = order rate × (1 − slippage) |
| `minOutPerIn` | user's hard floor (destination units per 1e18 wei); below it funds wait. 0 = none |
| `minDelivery` | before the deadline, deliver once `A` holds this much — at least POA's minimum withdrawal |
| `deadline` | swaps end by it; after it, remaining ETH is refunded |
| `recipientKind` | withdraw off NEAR through POA, or keep in an intents account |
| `refundTo` | Ethereum address for refunds (native ETH) |
| `destinationAsset` | intents ledger id, e.g. `nep141:zec.omft.near` |
| `recipient` | where the destination asset goes |

`owner` is the address ICE calls with — `EvmAccounts::evm_address(owner)`: an EVM account's own
address, a Substrate account's truncated id. Terms with any other owner cannot place an order.

### Derivation — three reads, no transactions

```
1. path = IntentDispatcher.computeAuthPath(terms)            keccak256 of the encoded terms

2. NEAR  v1.signer.derived_public_key({
             predecessor: "intents-router.hydration-whm.near",
             path, domain_id: 1 })                           // Ed25519
       → A = lowercase hex of the 32 key bytes               ← NEAR implicit account, no setup

3. POA   deposit_address({ account_id: A, chain: "eth:1" })
       → 0xN                                                 ← stored in the ICE intent
```

A plain native-ETH transfer to `0xN` credits `A` — no memo, no message. The SDK verifies the whole
chain at confirmation; on-chain nothing binds `0xN` to the terms, because POA's mapping exists only
in its RPC. That off-chain step happens exactly once per action.

**Change any term and you get a different account.** Extending a deadline or changing a recipient is
a new action. The terms are public (they travel in every order) and harmless: anyone holding them can
only run the owner's rules, and only the owner can place their orders.

**Derivation is public; authority is not.** Anyone can compute anyone's `A`; only the router's
account can obtain a signature for it (§11).

---

## 3. Hydration — one order per execution

ICE resolves the trade (asset → WETH, under ICE's own slippage limit), then forwards in a later block:
the runtime pushes the WETH to the dispatcher and calls it as the owner, in one storage transaction.
Swap intents must be non-partial: ICE forwards a swap only on full resolution. A direct caller uses
`dispatch` instead, batching `router.sell` first if it holds another asset.

```
execute(user, intentId, assetIn, amountIn, assetOut, amountOut, data)   ICE, as the owner
dispatch(amount, depositAddress, maxRelayFee, terms)                    direct; pulls the caller's WETH
  data = abi.encode(depositAddress, maxRelayFee, terms)

  1. WETH only; execute spends only WETH that arrived since the last order
  2. msg.sender == terms.owner
  3. outPerIn = ETH/USD ÷ DEST/USD from the destination's two feeds — older than maxFeedAge reverts
  4. bridged = WETH − NTT delivery price − order message fee, trimmed to NTT's 8 decimals
       ≥ minOrderAmount + maxRelayFee        POA's minimum deposit, after the relayer's cut
       maxRelayFee ≤ bridged / 2
  5. seq = NttManagerWithPayload.transferWithPayload(bridged, Ethereum, IntentForwarder,
                                                     depositAddress | maxRelayFee)
  6. publish the order message at 202; emit OrderPublished
  7. execute returns its selector
```

A revert anywhere rolls the whole call back — under ICE the WETH returns to the user and nothing is
bridged. That is how a stale feed fails closed: before value leaves Hydration. The rail's costs come
out of the WETH, which works because Hydration's native currency is WETH; the trim remainder stays
in the dispatcher as dust, sweepable by its owner and never spendable by a caller.

**The order message**, one per execution, consistency 202:

```
(authPath, seq, amount, outPerIn)
  authPath  = keccak256(terms) — computed by the dispatcher, so the price is bound to the terms' asset
  seq       = the NTT transfer's sequence — the order's id
  amount    = bridged − maxRelayFee: the least ETH A receives
  outPerIn  = destination units per 1e18 wei, before slippage
```

**One address, pinned three times.** ICE intents store the dispatcher as their callback, the router
pins it as the order emitter, and the forwarder pins it as the only sender whose transfers are
orders. It is a UUPS proxy: price sources, fees or the manager change by upgrade, and its address
never moves.

---

## 4. Price feeds

ETH/USD and each destination asset's USD price are DIA `AggregatorV3` feeds on Hydration, updated on
deviation. The dispatcher maps each destination asset to its two feeds and its decimals
(`setPriceRoute`) and refuses an answer older than `maxFeedAge` — about 6 h, above the longest gap
observed between ETH updates.

There is no price refresh: an order's message is the only price it ever gets. During a feed outage
the dispatcher stops bridging; while a feed is quiet but within `maxFeedAge`, a price can lag the
market by up to the feed's deviation threshold. Alert on stale feeds.

---

## 5. Ethereum — the forwarder

```
IntentForwarder.processOrder(nttVaa, feeRequested)      anyone; authorized relayers get 5 min first
  1. the transfer: from chain 73, sender == IntentDispatcher, to == the forwarder, 8 decimals
  2. its payload → depositAddress, maxRelayFee; feeRequested ≤ maxRelayFee
  3. once per NTT message digest
  4. deliver the VAA to the NTT transceiver unless someone already did; require its ETH released
  5. pay depositAddress amount − feeRequested, and the caller feeRequested — native ETH
```

Nothing is caller-supplied but the fee, and the fee is bounded by a ceiling the owner set on
Hydration. The destination comes from the transfer's payload, attested with the transfer; only a
transfer the pinned dispatcher sent is an order. NTT delivery is permissionless, so a settlement may
already be here — that skips step 4's delivery, not the check that its ETH was released (the inbound
rate limiter can queue a delivered transfer).

---

## 6. NEAR — the router

```
swap(terms, orderVaa, quote)                               anyone, 1 yocto
  path = keccak256(terms) → A                              v1.signer.derived_public_key
  order: emitter IntentDispatcher on chain 73, authPath == path,
         priced until min(terms.deadline, VAA time + price_validity)
  quote: signed by 1Click, ETH → the terms' destination, pays and refunds A, fresh
  fill  = min(A's ETH, max_fill_multiple × order.amount); amountIn within 1% below it
  A's ETH ≥ order.amount × (1 − max_order_shortfall_bps)  the order's own ETH has landed
  minAmountOut ≥ amountIn × outPerIn × (1 − maxSlippageBps), and ≥ the hard floor
  → sign: transfer amountIn ETH from A to the quote's deposit account

deliver(terms)   A's destination balance → recipient: from minDelivery before the deadline, any after
refund(terms)    after the deadline, A's ETH (≥ min_refund) → refundTo on Ethereum
```

The bot submits a signed swap to 1Click, whose solvers trade and pay the output back to `A` in the
same transaction; deliveries and refunds go to the solver relay. It holds only a NEAR gas key; anyone
can do its job.

- **Stateless.** The router stores configuration only — 1Click's quote keys and its params, both
  DAO-managed.
- **One fill per order.** The swap nonce comes from the order's `seq` and a fixed expiry; any quote
  for the same order re-signs the same nonce, and no order outlives its price.
- **The fill is never the caller's choice.** It is `A`'s whole ETH up to the cap, so a dust quote
  cannot spend an order.
- **Refunds never race swaps.** Every swap expires by the deadline; refunds start after it.
- **The invariant.** Every path to `v1.signer.sign` builds its payload only from the terms (bound to
  `A` by the hash), a verified order message, a quote 1Click signed, the clock and balance reads. No
  admin or generic sign.

---

## 7. Catch-up, retries and refunds

**Every fill spends what landed.** `order.amount` is the least ETH an order brings, the relay fee
is capped at half of what bridged, and `max_fill_multiple` is at least 2 — so one fill takes all of
it. If a tranche does not fill, its ETH stays in `A` and the next order buys it at that order's price,
up to its own cap: the next order *is* the retry, never below the user's hard floor.

**No next order** — a single swap, or a DCA's last tranche: while its order is priced, the bot may
quote again and re-sign the same nonce; after that the funds wait for the deadline and are refunded.
A 1Click swap that does not fill returns the ETH to `A`.

**Refund only after the deadline.** Below the hard floor funds hold rather than refund, so a brief dip
cannot force an exit. Refunds arrive as native ETH on Ethereum at `refundTo`. The SDK ends the ICE
schedule a grace period before the deadline so the last tranche can still settle.

**Failed ICE callbacks are not retried** by the runtime — a stale feed, a full outbound rate limit or
an amount below the minimum leaves the WETH with the user on Hydration. Scan surfaces it; the owner
can send it on with `dispatch`.

---

## 8. Residual

- **The surplus above 1Click's quote is the solvers'.** The floor bounds the downside; it does not
  win the best price. A Dutch auction strategy could ([dutch-auction.md](dutch-auction.md)).
- **A compromised bot can stall**, and choose when to quote within an order's price validity. It
  cannot redirect, fill below the floor or refund early.
- **A relayer takes up to `maxRelayFee`** — the owner's ceiling, at most half the order.
- **Trust:** Wormhole guardians, the WETH NTT managers' owners (Hydration governance; rate limits),
  the MPC network, POA custody, `intents.near` governance, 1Click (its quote keys and deposit
  accounts), the router DAO (upgrades, quote keys, params), the dispatcher owner (price routes,
  minimums, the manager and forwarder it uses, upgrades), the forwarder owner (the dispatcher it
  pins, relayers, upgrades) and the SDK's `terms → 0xN` mapping.

---

## 9. What has to be verified

The router's own gates — 1Click as counterparty, the bytes `intents.near` verifies, POA crediting a
contract's deposit, the `v1.signer` request — were run on mainnet ([verification.md](verification.md)).
Before a canary: the dispatcher's `execute` within ICE's 2M gas on a Hydration fork, the WETH NTT
managers carrying the payload on both sides, ICE `Forward` in the live runtime, the router's gas on
testnet, refunds through 1Click, control of `intents-router.hydration-whm.near`, and monitoring. The
full list is in [plan.md §5](plan.md#5-gates).

---

## 10. Why derived accounts

Five ways to make the unattended case work without MPC derivation, all tested against the live APIs,
all dead. Recorded so nobody re-litigates them.

**A fresh 1Click quote per tranche, to a fresh 1Click address** needs an HTTP call inside the
critical path of an on-chain schedule, which an on-chain schedule cannot make. Delegating it to a bot
moves the problem: whoever requests the quote picks `recipient`, and with no user in the loop nothing
checks that choice. (v2 quotes per order too — but into `A`, whose recipient the terms fix.)

**Pre-minting N addresses at schedule creation** freezes the floor at quote time. Late tranches then
execute against a stale floor and refund instead of filling. It also cannot express a rolling,
unbounded-N schedule.

**Reusing one 1Click address** is impossible: they are non-deterministic. Byte-identical requests
return different addresses in all three deposit modes.

**An `ANY_INPUT` collector** only sweeps once a pool clears $1,000, and is `INTENTS`-only —
`400 "ANY_INPUT only supports depositType INTENTS or CONFIDENTIAL_INTENTS"` — so Wormhole cannot
deliver into it at all.

**Letting the bot hold the intents key** fails on `intents.near` having no per-key scoping: _"Every
public key registered to an account can sign intents on its behalf."_ A key is unbounded authority.

MPC derivation is what remains, and it removes the key from every human-operated component.

---

## 11. Key derivation and authority

No private key for `A` exists anywhere. It is MPC-derived, keyed on `(predecessor, path)`:

```
intents-router.hydration-whm.near + path → A₁ → 0xN₁
attacker.near                     + path → A₂ → 0xN₂      (disjoint account, same path)
```

**Code identity is irrelevant; only account identity matters.** A byte-identical router deployed to
another account derives a disjoint set of accounts and cannot sign for ours. `predecessor` is an
argument on the public view `derived_public_key`, so anyone can compute anyone's `A`; on `sign` it is
not an argument — the MPC network takes the runtime's true caller.

**Deploy to a sub-account.** Derivation binds to an account id; if that id could be re-registered by
someone else, they would inherit every derived account. `intents-router.hydration-whm.near` can only
be created by `hydration-whm.near`.

**The invariant that carries the design.** Nothing external constrains how `A` is spent —
`intents.near` honours any valid signature for it. Two layers produce the guarantee:

- **Who can sign for `A`** — only the router's account derives its key. Cryptographic.
- **What the router signs** — only payloads built from the terms (bound to `A` by the hash), a
  verified order message, a quote 1Click signed, the clock and balance reads.

> Every code path from a public method to `v1.signer.sign` builds its payload only from those
> inputs. Deliveries and refunds ignore the order message and the quote, because their action and
> destination are fixed by the terms. No admin sign, no generic `sign(payload)`, no debug helper, no
> public callback.

**Upgrades.** Because derivation binds to the account id, not the code hash, whoever can change the
router's code controls every `A`. The router follows the near-ntt model: account keys deleted, code
changed only through an owner-gated `upgrade`, ownership held by `hydration.sputnik-dao.near`. That
DAO is therefore trusted with every account — an accepted decision, stated rather than hidden.

**Nothing binds the deposit side.** `0xN` is publicly derivable, so anyone may deposit to it and the
funds land in `A`. Harmless — they can only ever leave by the terms — but not a control.
