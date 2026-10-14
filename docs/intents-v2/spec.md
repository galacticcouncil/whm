# SPEC — Intents v2: unattended swaps and DCA

v2 replaces 1Click. A user creates a swap or a DCA once; every execution afterwards runs with
nobody present, no HTTP call and no keys. Two things make that possible, and they are the whole
design:

- **The deposit address is derived once**, from terms the user signs at creation. One action — a
  swap, or a whole DCA schedule — has one NEAR account `A` and one Ethereum deposit address `0xN`,
  reused by every tranche. Nothing off-chain picks where funds go.
- **The price is read on Hydration** in the transaction that fires each tranche, and travels to NEAR
  in a guardian-signed **order** message. Nothing off-chain picks the rate either.

The value rail — Hydration WETH → NTT → Ethereum → POA — is unchanged; see
[spec.md](../intents/spec.md#shared-transport). Implementation detail, data formats and review history:
[plan.md](plan.md).

| Component | Chain | Status | Role |
| --- | --- | --- | --- |
| `IntentDispatcher` | Hydration | new | ICE callback; reads feeds; `placeOrder` then `publishOrder`. All logic lives here. |
| `IntentQuoteEmitter` | Hydration | rework | thin, stable publisher: `publishOrder(terms, order)`. Its address is what NEAR pins. |
| `IntentEmitter`, `IntentReceiver` | Hydration, Ethereum | live, unchanged | the value rail |
| `IntentRouter` | NEAR | new | stateless, DAO-upgradeable; terms + order message → signed intent |
| Bot | off-chain | new | NEAR gas key only; `finalize`, publish, reconcile balances |
| Price feeds | Hydration | to deploy | ETH and destination assets, hourly + on a 0.1% move |

**Guarantees.** Funds in `A` only ever go to `recipient` (as `destinationAsset`) or to `refundTo`.
No fill below `outPerIn × (1 − maxSlippageBps)` or below the hard floor. One fill per order. No
number comes from the bot. A stale feed bridges nothing. **Not guaranteed:** the best market price;
a price fresher than `maxFeedAge` during a feed outage; automatic recovery of a failed ICE callback;
refunds on Hydration (they arrive as ETH on Ethereum).

---

## 1. From the user's side

```
 ONCE, at creation                               user present, one signature
   ├─ pick asset, amount, cadence, destination asset, recipient, refund address
   ├─ SDK builds the terms and derives A → 0xN   §2
   ├─ user checks `recipient` and `refundTo`
   └─ ICE swap or DCA intent created on Hydration, its callback pointing at IntentDispatcher

 EVERY EXECUTION                                 nobody present
   ├─ HYDRATION   ICE trades asset → WETH; callback: price, placeOrder, publishOrder   §3
   ├─ ETHEREUM    relayer delivers, forwards native ETH to 0xN          (shared rail, unchanged)
   ├─ POA         credits A with nep141:eth.omft.near                   (not our transaction)
   ├─ NEAR        bot calls finalize(terms, orderVaa); router signs      §5
   └─ DESTINATION the asset arrives at `recipient`
```

**What the user is trusting.** `recipient` and `refundTo` are inside the terms, and the terms are
what derive `A` — so nothing can spend `A` anywhere else. The price comes from the order message,
the amount from `A`'s balance. No number in the flow is supplied by an off-chain party.

**What it gives up.** Each fill is a limit order at the oracle floor; what the market would have paid
above it goes to the solver (§7).

**What happens when nothing fills.** The ETH waits in `A`. The next order buys it; after the
deadline it is refunded (§6).

---

## 2. SDK — terms and the deposit address

### Terms

One set per action, all hashed into the account:

| Field | Meaning |
| --- | --- |
| `quoteId` | random 32 bytes — keeps the user's actions on separate accounts |
| `maxSlippageBps` | NEAR floor = order rate × (1 − slippage) |
| `minOutPerIn` | user's hard floor (destination units per 1e18 wei); below it funds wait. 0 = none |
| `deadline` | after it, remaining funds are refunded |
| `recipientKind` | withdraw off NEAR, or keep in an intents account |
| `refundTo` | Ethereum address for refunds (native ETH) |
| `destinationAsset` | intents token id of a supported route, e.g. `nep141:zec.omft.near` |
| `recipient` | where the destination asset goes |

### Derivation — three reads, no transactions

```
1. path = IntentQuoteEmitter.computeAuthPath(terms)          keccak256 of the encoded terms

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
a new action. The terms are public (they travel in every order) and harmless: anyone holding them
can only run the user's own rules.

**Derivation is public; authority is not.** Anyone can compute anyone's `A`; only the router's
account can obtain a signature for it (§10).

---

## 3. Hydration — one callback per execution

ICE resolves the trade (asset → WETH, under ICE's own slippage limit), then calls the dispatcher in a
later block through its `OnResolved::Forward` callback, pushing the WETH first. Swap intents must be
non-partial: ICE forwards a swap only on full resolution.

```
IntentDispatcher.execute(user, intentId, assetIn, amountIn, assetOut, amountOut, data)
  data = (depositAddress, maxRelayFee, terms)
  1. require assetOut == WETH
  2. outPerIn = ETH/USD ÷ DEST/USD from Hydration feeds   — stale feed (older than maxFeedAge) reverts
  3. seq = IntentEmitter.placeOrder(WETH, amount, minEthOut, depositAddress, maxRelayFee)
         minEthOut covers POA's minimum deposit after trimming and the relay-fee ceiling
  4. IntentQuoteEmitter.publishOrder(terms, Order(seq, amount, outPerIn))
  5. return the ack selector
```

A revert anywhere rolls the whole callback back — the WETH stays in the user's account and nothing
is bridged. That is how a stale feed fails closed: before value leaves Hydration.

**Two contracts, split by who pins their address.**

| | Pinned by | Holds |
| --- | --- | --- |
| `IntentDispatcher` | ICE intents (stored in the callback) | all logic: callback, price read, `placeOrder` |
| `IntentQuoteEmitter` | the NEAR router (its Wormhole emitter) | only `publishOrder`: hashes the terms, emits them, publishes the order message |

Changing the price source or the rail is a dispatcher upgrade; the emitter's address never moves, so
the router never needs repointing. Only authorized dispatchers may call `publishOrder` — an order's
`seq` must come from a real `placeOrder`.

**The order message**, one per execution, consistency 202:

```
(authPath, seq, amount, outPerIn)
  authPath  = keccak256(terms)  — computed by the emitter, so the price is bound to the terms' asset
  seq       = the NTT manager sequence of this order
  amount    = WETH this order sent (informational)
  outPerIn  = destination units per 1e18 wei, before slippage
```

`IntentEmitter` and `IntentReceiver` are untouched.

---

## 4. Price feeds

ETH/USD and each destination asset's USD price live on Hydration as `AggregatorV3` feeds, pushed
**hourly and on every 0.1% move**. The source is open (Pyth pulled onto Hydration, or the existing
`OracleEmitter` rail from Ethereum); either way the dispatcher reads them and refuses a feed older
than heartbeat + margin.

There is no price refresh: an order's message is the only price it ever gets. During a feed outage
the dispatcher stops bridging; if the broadcaster dies right after a heartbeat, a price can lag the
market by up to `maxFeedAge` before that check trips. Alert on missed heartbeats.

---

## 5. NEAR — `finalize(terms, orderVaa)`

Two arguments. Every number comes from the order message, the terms or a balance read.

```
finalize(terms, orderVaa)
  path = keccak256(terms) → A                 (v1.signer.derived_public_key)
  read A's ETH and destination balances; verify orderVaa (before the deadline)

  past terms.deadline:
     ETH ≥ minimum                → refund ETH to refundTo
     else destination ≥ minimum   → deliver it to recipient
  before:
     destination ≥ minimum        → deliver it to recipient   (recovery after a failed withdrawal)
     order: emitter = IntentQuoteEmitter on chain 73, authPath == path, age ≤ price_validity
     amount_in  = ETH balance
     amount_out = amount_in × outPerIn × (1 − slippage) / 1e18
     amount_out ≥ amount_in × minOutPerIn / 1e18   else hold
     → sign: give amount_in ETH, receive amount_out, withdraw to recipient

  v1.signer.sign(...) → emit the signed payload
```

- **Stateless.** The router stores configuration only.
- **One fill per order.** The nonce comes from the order's `seq` and a fixed expiry
  `min(terms.deadline, order timestamp + price_validity)`; re-signing an order reproduces it, and no
  order outlives its price.
- **Refunds never race swaps.** Every swap expires by the deadline; refunds start after it.
- **The invariant.** Every path to `v1.signer.sign` builds its payload only from the terms (bound to
  `A` by the hash), a verified order message, the clock and balance reads. No admin or generic sign.

The bot then publishes the payload with `publish_intent([], signed)` and polls `get_status`. It holds
only a NEAR gas key; anyone can do its job.

---

## 6. Catch-up, retries and refunds

**Every fill spends the whole balance.** If a tranche does not fill, its ETH stays in `A` and the next
order buys it at that order's price — the next order *is* the retry. A missed tranche is bought late
at a then-current oracle price, never below the user's hard floor.

**No next order** — a single swap, or a DCA's last tranche: while its order message is valid the bot
may re-sign it; after that the funds wait for the deadline and are refunded.

**Refund only after the deadline.** Below the hard floor funds hold rather than refund, so a brief dip
cannot force an exit. Refunds arrive as native ETH on Ethereum at `refundTo`. The SDK ends the ICE
schedule a grace period before the deadline so the last tranche can still settle.

**Failed ICE callbacks are not retried** by the runtime. The WETH stays with the user on Hydration;
scan surfaces it and the user can send it on manually.

---

## 7. Residual

- **The surplus above the floor goes to the solver.** Recovering it needs price discovery — relay
  quotes or a Dutch auction ([dutch-auction.md](dutch-auction.md)) — later.
- **A compromised bot can stall**, and choose among a path's still-valid orders. It cannot redirect,
  misprice below the floor or refund early.
- **Anyone can trigger a catch-up** of a path by placing their own order with its public terms,
  paying their own fees — at the current oracle price.
- **Trust:** Wormhole guardians, the MPC network, POA custody, `intents.near` governance, the router
  DAO (it can upgrade the router), the dispatcher owner (price routes), and the SDK's `terms → 0xN`
  mapping.

---

## 8. What has to be verified

Blocking, before the router merges:

- **Solvers fill an unmatched intent** — a posted limit order with `quote_hashes: []`, including a
  catch-up-sized one.
- **The exact bytes `intents.near` verifies** — NEP-413 digest, versioned nonce, deadline, swap plus
  withdrawal, failed withdrawal. See [schema.md](schema.md) §4.
- **POA credits ETH forwarded by a contract**, its minimum and its crediting delay.
- **The live `v1.signer` request format**, signature, deposit and latency.

Before a canary: feeds live on Hydration, ICE `Forward` in the target runtime, control of
`intents-router.hydration-whm.near`, and monitoring. The full list is in
[plan.md §5](plan.md#5-gates).

---

## 9. Why derived accounts

Five ways to make the unattended case work without MPC derivation, all tested against the live APIs,
all dead. Recorded so nobody re-litigates them.

**A fresh 1Click quote per tranche** needs an HTTP call inside the critical path of an on-chain
schedule, which an on-chain schedule cannot make. Delegating it to a bot moves the problem: whoever
requests the quote picks `recipient`, and with no user in the loop nothing checks that choice.

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

## 10. Key derivation and authority

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
  verified order message, the clock and balance reads.

> Every code path from a public method to `v1.signer.sign` builds its payload only from those
> inputs. Refunds and deliveries ignore the order message, because their action and destination are
> fixed by the terms. No admin sign, no generic `sign(payload)`, no debug helper, no public callback.

**Upgrades.** Because derivation binds to the account id, not the code hash, whoever can change the
router's code controls every `A`. The router follows the near-ntt model: account keys deleted, code
changed only through an owner-gated `upgrade`, ownership held by `hydration.sputnik-dao.near`. That
DAO is therefore trusted with every account — an accepted decision, stated rather than hidden.

**Nothing binds the deposit side.** `0xN` is publicly derivable, so anyone may deposit to it and the
funds land in `A`. Harmless — they can only ever leave by the terms — but not a control.
