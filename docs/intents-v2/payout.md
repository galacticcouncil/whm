# Payout — POA vs UTXO

How a trade's output leaves NEAR for the recipient's chain, what each path costs, and who controls the
funds on the way. ZEC is the worked example; the shape holds for any destination with both paths.

A payout is the terms', not one order's: every tranche's swap credits `A`, and `deliver` sends `A`'s
whole destination balance — before the deadline once it reaches `minDelivery`, after it any balance.
A refund is ETH only and always goes through POA to `refundTo` on Ethereum.

## Who decides the route

The router, never the bot. The bot's 1Click quote only covers the swap, and the router rejects any
quote whose recipient is not `A` with `recipientType` INTENTS (`WrongRecipient`) — the output always
lands in `A`'s balance inside `intents.near`. `deliver(terms)` takes no destination: the router builds
the `ft_withdraw` itself from the terms and its own config. `deliver` is permissionless, so a
caller-supplied destination would let anyone redirect a payout; this is also why the router derives
the UTXO account on-chain rather than taking it as an argument.

Terms' `recipientKind` 0 means "withdraw to the asset's own chain" — which bridge carries it is the
router's choice. Kind 1 is an `intents.near` transfer to a NEAR account and never withdraws.

NEAR's own chain is NEAR: kind 0 of `nep141:wrap.near` is `native_withdraw`, which unwraps the wNEAR
and transfers native NEAR to the recipient in the same transaction — no bridge, no fee beyond gas, as
v1 and 1Click pay NEAR. A named recipient account must exist, or `intents.near` keeps the NEAR.

## The accounts

| Account  | Derived from                                        | Holds                                             |
| -------- | --------------------------------------------------- | ------------------------------------------------- |
| `A`      | `auth_path`, predecessor the router                 | ETH and the output, inside `intents.near`         |
| `A_utxo` | `"zcash:v1:" + address`, predecessor `withdraw-zec` | ZEC as a plain NEP-141 balance on `zec.omft.near` |

Both are implicit accounts whose key is MPC-derived (`v1.signer`, domain 1). Derivation is one-way: an
account id says nothing about its path or which path it serves, and the route is not encoded in `A` —
it is chosen at each `deliver`. To check a candidate, derive forward and compare
(`withdraw-zec.path_of(address)` gives the UTXO path). `A_utxo` depends on the address only, so every
payout, order and trade to one address shares it.

## POA (live)

```
swap      1Click → A                    A's balance inside intents.near
deliver   A → zec.omft.near             ft_withdraw with memo WITHDRAW_TO:<address>: a burn
withdraw  POA bridge → Zcash            POA sees the burn, pays <address> from its own wallet, −72k zats
```

No setup, no second bot. After the burn everything is POA's own off-chain process — its fee, its
timing. POA covers any `*.omft.near` asset, transparent or not.

## UTXO

```
swap      1Click → A                    A's balance inside intents.near
deliver   A → A_utxo                    ft_withdraw: a plain NEP-141 balance on zec.omft.near
withdraw  A_utxo → connector → Zcash    withdraw-zec signs A_utxo's delegate
```

Who runs each step, with the one-time setup:

```
0. once per address  router bot: storage_deposit(A_utxo) on zec.omft.near    0.00125 NEAR
                     utxo bot:   create A_utxo (1 yocto transfer)             before its first delegate
1. swap              router bot: router.swap → 1Click → A
2. deliver           router bot: router.deliver → ft_withdraw A → A_utxo
3. withdraw          utxo bot:   withdraw-zec.withdraw(address, coin), relays the delegate
                                 → A_utxo ft_transfer_call → zcash-connector.bridge.near
4. on Zcash          omni-relayer.bridge.near signs and broadcasts; address gets amount − 20k zats
```

- **Unregistered `A_utxo`** — `intents.near`'s `ft_resolve_withdraw` sees the failed `ft_transfer` and
  credits the whole amount back to `A`; `deliver` can run again once registered. Read in the source
  the deployed v0.4.5 names (`near/intents` `16d04f6`, `nep141/withdraw.rs`). The intent's own
  `storage_deposit` field pays from the signer's wNEAR inside `intents.near`, which `A` does not have,
  so the bot registers beforehand.
- **Minimum** — the connector's `min_withdraw_amount` is 100,000 zat. A smaller balance waits on
  `A_utxo` until a later payout to the same address tops it up.
- **Transparent only** — `withdraw-zec` accepts `t1`/`t3`. Shielded and unified addresses stay on POA.
- **Connector paused** — the ZEC waits on `A_utxo` and the bot retries. It is not lost, but it cannot
  fall back to POA.

The same contract serves any UTXO chain with an Omni connector — one `utxo-withdraw` deployment per
chain plus its `chains/<chain>.rs` module. Account-based chains have no UTXO path.

## Fees

Per payout. NEAR $3.01, ZEC $846.75 (CoinGecko, 2026-11-20): 0.001 NEAR ≈ 355 zat.

|                                                    | POA                      | UTXO, first to an address           | UTXO, later              |
| -------------------------------------------------- | ------------------------ | ----------------------------------- | ------------------------ |
| **User, in ZEC**                                   | 72,000 zat               | 20,000 zat (10k bridge + 10k miner) | 20,000 zat               |
| Bot: `deliver`                                     | 0.0029                   | ~0.0031 (one more derive)           | ~0.0031                  |
| Bot: `A_utxo` registration on `zec.omft.near`      | —                        | 0.00125 + ~0.0003 gas               | —                        |
| Bot: create `A_utxo` (1 yocto + gas)               | —                        | ~0.00005                            | —                        |
| Bot: `withdraw-zec.withdraw` (20.8 TGas + 1 yocto) | —                        | 0.0021                              | 0.0021                   |
| Bot: relay the delegate (~12 TGas)                 | —                        | 0.0012                              | 0.0012                   |
| Bot: refund penalty on unused gas (inferred)       | —                        | ~0.002                              | ~0.002                   |
| **Bots, in NEAR**                                  | **0.0029 ≈ $0.009**      | **~0.0101 ≈ $0.030**                | **~0.0084 ≈ $0.025**     |
| **All in**                                         | **≈ 73,000 zat ≈ $0.62** | **≈ 23,600 zat ≈ $0.20**            | **≈ 23,000 zat ≈ $0.19** |

The swap (~0.0038 NEAR per tranche) is the same on both paths and left out. A 3-tranche plan paid out
three times: POA 216,000 zat ($1.83) from the user plus 0.009 NEAR; UTXO 60,000 zat ($0.51) plus
~0.027 NEAR ($0.08).

Where the numbers come from:

- **POA, 72,000 zat** — observed on every delivery, flat whatever the amount: POA's listed withdrawal
  fee of 47,000 zat plus 25,000 taken on chain ([verification.md](verification.md), G3). A Zcash
  transaction costs ~10,000 zat under ZIP-317; the rest is POA's pricing. POA lists a 0.01 ZEC
  minimum, but smaller withdrawals pay out.
- **UTXO, 20,000 zat** — the live connector config: `withdraw_bridge_fee` 10,000 flat; the miner fee
  `withdraw-zec` sets, ZIP-317 for one input and at most two outputs.
- **Bot NEAR** — `deliver` measured on the router; the withdraw steps measured on the Hydration UTXO
  route ([withdraw spec § Sizing the fee](../near-utxo/withdraw/spec.md)), where `ntt complete` takes
  the place `deliver` has here.

UTXO costs the user about a third; it costs the bots about three times the NEAR. On the Hydration UTXO
route the emitter's `fee` refills the bots; on this path nothing does unless a fee is added.

For comparison, quoting 1Click straight to Zcash (`DESTINATION_CHAIN`) costs ~32–39k zat per swap.
With two or more tranches that is no cheaper than one batched POA payout, and always dearer than UTXO.

## Control

Whoever can change a contract's code controls every account it signs for.

| Funds                          | Moved by                            | Code changed by                            |
| ------------------------------ | ----------------------------------- | ------------------------------------------ |
| `A`'s, in `intents.near`       | `intents-router.hydration-whm.near` | `hydration.sputnik-dao.near` only; no keys |
| `A_utxo`'s, on `zec.omft.near` | `withdraw-zec.hydration-whm.near`   | `hydration.sputnik-dao.near` only; no keys |

Trusted underneath either way: `v1.signer` (the MPC network), `intents.near` (custody and ledger),
and `zec.omft.near`'s issuer — the connector names the same token, so POA and Omni share it. POA adds
its bridge operators, who hold the ZEC on Zcash and pay out. UTXO adds the Omni connector:
`rainbowbridge.sputnik-dao.near` administers it, its MPC holds the Zcash side, and
`omni-relayer.bridge.near` is the only account allowed to sign withdrawals — a dependency for the path
to keep working, not for the funds to stay safe.

## Router support for UTXO

Configurable per token; an empty map is today's behaviour. Hydration, the terms and the codec do not
change.

- **State** — `utxo_routes: token → withdraw contract` (e.g. `zec.omft.near → withdraw-zec.hydration-whm.near`),
  plus a `migrate`.
- **Config** — owner-only `set_utxo_route(token, Option<AccountId>)`; view `utxo_routes()`.
- **`deliver`** — for kind 0 with a route and a transparent address, the payout read also derives
  `A_utxo`, and the intent becomes `ft_withdraw(token, receiver A_utxo, no memo)`. Anything else stays
  on POA. Optionally a per-route minimum, under which POA is used.
- **Address check** — `utxo-withdraw`'s `chains/zcash.rs`, shared rather than copied: if the router
  accepts an address `withdraw` rejects, the ZEC is stuck on `A_utxo`.
- **Event** — `intent_signed` gains `route` (`utxo` | `poa`) and `A_utxo`.
- **Router bot** — registers `A_utxo` (checking `storage_balance_of`) before a UTXO `deliver`, reading
  the routes from `utxo_routes()`.
- **UTXO agent** — the router's `route: "utxo"` deliveries as a second trigger beside Hydration's
  `WithdrawRequested`, into the same handler.
- **Scan** — nothing required: the payout poller pairs the Zcash transaction by recipient, for no more
  than was withdrawn. Optionally "via UTXO" from the event.

The route is chosen at payout time, so switching it applies to running trades too, with the same
destination.

## Unverified

- `ft_resolve_withdraw`'s refund was read in source, not run: `intents.near`'s build is declared
  non-reproducible, so the wasm is only claimed to match `16d04f6`. One delivery to an unregistered
  account settles it.
- The extra derive's gas in `deliver` — measurable once the route is built.
