# Price Integrity — the models

The VAA fixes _where_ funds go. It does not fix _at what price_.

The router signs a `token_diff`, and a `token_diff` is an exact ratio. Whoever fills in `amount_out`
sets the execution price. Hydration has no ZEC feed, `quote_hash` is an opaque relay handle a contract
cannot resolve, and NEAR has no ZEC depth to read — so nothing in the path can check that number.

The system is **redirect-proof, not price-proof**. There are two ways to close that: the price is
**specified on Hydration** and carried in the guardian-signed quote, or it is **discovered by a
descending auction** and nobody specifies it at all.

| model                | price comes from           | captures upside | new infra              |
| -------------------- | -------------------------- | --------------- | ---------------------- |
| sanity bounds        | the bot                    | —               | none                   |
| exact amounts        | the publisher, once        | no              | none                   |
| static rate floor    | the publisher, once        | no              | none                   |
| oracle-derived floor | Pyth, at publish time      | no              | Pyth → Hydration relay |
| Dutch auction        | the market, per tranche    | yes             | K MPC sigs per tranche |
| floor + auction      | Pyth bounds, market clears | yes             | both                   |

---

## 1. Sanity bounds — the baseline

Router rejects zero and overflow, takes whatever the bot's solver quote says, and relies on solver
competition plus alerting.

The residual is collusion: a compromised bot and a cooperating solver agree a poor rate and split the
spread. Neither can move the funds — `recipient` is guardian-signed — so this is value extraction,
bounded by nothing but reputation.

Cheapest, and the honest baseline. Shipping it means not calling the system trustless without saying
which half is trusted.

---

## 2. Price specified on Hydration

The number travels inside the quote, hashed into `authPath` like every other term. Republishing with a
different number derives a different account, which is what keeps publishing permissionless — no field
exists that a stranger could rewrite to weaken someone else's price.

Three variants, differing only in where the number comes from.

### 2.1 Exact amounts

Publish `amountIn` / `amountOut` and the bot loses its discretion entirely.

It bounds the vector without closing it — whoever publishes still chooses the pair. And it does not
survive a rolling schedule: the pair is set once, while tranches differ in size (the relay fee is
deducted in flight) and the market moves between them. That is the same staleness that killed
pre-minting N addresses.

### 2.2 Static rate floor

`minOutPerIn` as a rate, not an amount, so one quote serves every tranche whatever its size.

Real protection against a bad fill, and one-sided. A floor says only what the worst acceptable price
is; a solver can fill exactly there and keep everything above it. When the market moves in the user's
favour, the user does not see it.

Which is the actual requirement — _always the best available price, never below the limit_ — and a
floor alone cannot express it.

### 2.3 Oracle-derived floor

Same mechanism as 2.2, with the number derived from a feed instead of picked by hand.

Pyth is the candidate because it already broadcasts over Wormhole — Pythnet is chain 26, and its
accumulator VAAs are guardian-signed like any other, which is the rail this repo already operates for
oracles. A Pythnet VAA lands in an `OracleReceiver`-shaped contract on Hydration's EVM and writes
ZEC/USD and NEAR/USD the same way Kamino and wstETH rates already arrive. `IntentQuoteEmitter` then
reads the oracle at `publishQuote` time and commits `price × (1 − slippageBps)` into the path.

**This makes the number defensible, not live.** The floor is still fixed for the life of the schedule
— the oracle makes it right at publication, not right forever. Tracking the market means republishing,
and republishing derives a new account, which is the residual-balance problem in
[dutch-auction.md](dutch-auction.md) §6.

Practicalities: Pyth is pull-based, so someone pays to post updates; feeds carry a confidence interval
that a floor should widen by rather than ignore; staleness must be a hard reject, not a warning. The
relay leg already runs — `agents/relayer`'s `oracle` app has two production routes — so this is a
`PythAdapter` plus a `registerFeed` per asset, not an integration. Design:
[phase2.md](phase2.md) §4.

---

## 3. Dutch auction

The router offers a descending ladder of prices, one live at a time, and the first solver willing to
take a level takes it. Nobody supplies a price: every level is a function of the published terms and
elapsed time, so `amount_out` leaves the interface entirely.

The only model here that captures upside. It is also the only one that needs no feed at all, which
matters because ZEC and NEAR are exactly the assets nothing we already run covers.

Costs and open items: K MPC signatures per tranche against NEAR's 300 TGas cap, with the payer
unresolved; correctness rests on the intents verifier treating `deadline` as binding, otherwise the
ladder becomes a menu; and a cancellation path does not exist yet.

Full design: [dutch-auction.md](dutch-auction.md).

---

## 4. Floor + auction

They compose. The oracle sets the ladder's bounds — `startRate` a margin above the feed, reserve a
margin below — and the auction discovers the clearing price between them.

Both halves are doing something the other cannot. The feed anchors the ladder to the market at
publication; the auction absorbs the drift after it, which is why the span has to be wide enough to
cover the schedule's life rather than just the first tranche.

It also removes the ugliest open item in the auction design. `startRate` picked by hand will drift, and
[dutch-auction.md](dutch-auction.md) §8 works around that with self-calibration from observed fills —
which needs a reported clear, and a report that can lower the seed is itself an attack on price. A feed
replaces that with a number nobody in the loop controls.

---

## Recommendation

Ship §1 with monitoring and the residual documented, because it is what works today.

Add the Pyth → Hydration feed next. It reuses a rail we already operate, and it turns §2.2 from a
hand-picked number into a defensible one — worth doing whether or not the auction ever gets built,
since §4 wants the same feed.

This is the option that was taken. Publishing the quote **per tranche** rather than per route is what
removes the staleness §2.3 warns about: the oracle is read in the transaction that fires the tranche,
so the floor is never older than the trade it prices. Full design: [phase2.md](phase2.md).

Reach for §3 when the spread given away by a floor costs more than K signatures per tranche, and treat
§4 as its end state rather than as a separate option.

## Unverified

- A readable Pyth ZEC/USD and NEAR/USD feed, and whether it is sponsored or we pay for updates.
- `SIGN_DEPOSIT` and `SIGN_GAS` per MPC signature, which decides whether §3 is affordable at all.
- That the intents verifier treats a payload `deadline` as binding — §3 does not work without it.

Add anything settled here to [verification.md](verification.md).
