# Payout — UTXO routes

How a trade's output leaves NEAR for the recipient's chain, what it costs, and who controls the funds
on the way.

A payout is the terms', not one order's: every tranche's swap credits `A`, and `deliver` sends `A`'s
whole destination balance — before the deadline once it reaches `minDelivery`, after it (or a close's
countdown) any balance from the route's minimum. A refund is ETH only and goes through POA to
`refundTo` on Ethereum — POA's one role here.

## What can be paid out

The scope is Omni's assets on their home chains — the same tokens the NTT bridge carries:

| Asset | Ledger id                 | `recipientKind` 0                                      | Kind 1           |
| ----- | ------------------------- | ------------------------------------------------------ | ---------------- |
| ZEC   | `nep141:zec.omft.near`    | UTXO route → `withdraw-zec` → Zcash `t1…`/`t3…`        | intents transfer |
| BTC   | `nep141:nbtc.bridge.near` | UTXO route → `withdraw-btc` → Bitcoin `1…`/`3…`/`bc1…` | intents transfer |
| NEAR  | `nep141:wrap.near`        | `native_withdraw`: native NEAR to a NEAR account       | intents transfer |

Kind 0 of anything else — a token with no route, or an address its route does not accept (a shielded
`zs…`/`u1…`) — is not deliverable: the router refuses to swap such terms, so their ETH is refunded.
Kind 1 is an `intents.near` transfer of any asset 1Click can buy.

Omni's Zcash connector withdraws `zec.omft.near` — a token POA issued and Omni took over — and its
Bitcoin connector `nbtc.bridge.near`, Omni's own. POA's bitcoin, `btc.omft.near`, is a different token
with no Omni exit, and out of scope.

## Who decides the route

The router, never the bot — from the token's route, set by the router's owner. The bot's 1Click quote
only covers the swap, and the router rejects any quote whose recipient is not `A` with
`recipientType` INTENTS (`WrongRecipient`) — the output always lands in `A`'s balance inside
`intents.near`. `deliver(terms)` takes no destination: the router builds the `ft_withdraw` itself
from the terms and its route. `deliver` is permissionless, so a caller-supplied destination would let
anyone redirect a payout; this is also why the router derives `A_utxo` on-chain rather than taking it
as an argument.

## The accounts

| Account  | Derived from                                                 | Holds                                     |
| -------- | ------------------------------------------------------------ | ----------------------------------------- |
| `A`      | `auth_path`, predecessor the router                          | ETH and the output, inside `intents.near` |
| `A_utxo` | `"<chain>:v1:" + address`, predecessor the withdraw contract | the token as a plain NEP-141 balance      |

Both are implicit accounts whose key is MPC-derived (`v1.signer`, domain 1). Derivation is one-way: an
account id says nothing about its path. To check a candidate, derive forward and compare
(`withdraw-zec.path_of(address)` gives the path). `A_utxo` depends on the address only, so every
payout, order and trade to one address — and Hydration's own UTXO withdrawals to it — share it.

## The flow

```
swap      1Click → A                    A's balance inside intents.near
deliver   A → A_utxo                    ft_withdraw: a plain NEP-141 balance on the token
withdraw  A_utxo → connector → chain    the withdraw contract signs A_utxo's delegate
```

Who runs each step, with the one-time setup:

```
0. once per address  router bot: storage_deposit(A_utxo) on the token        0.00125 NEAR
                     utxo bot:   create A_utxo (1 yocto transfer)             before its first delegate
1. swap              router bot: router.swap → 1Click → A
2. deliver           router bot: router.deliver → ft_withdraw A → A_utxo
3. withdraw          utxo bot:   withdraw-<coin>.withdraw(address, coin), relays the delegate
                                 → A_utxo ft_transfer_call → the coin's Omni connector
4. on the chain      omni-relayer.bridge.near signs and broadcasts
```

- **Unregistered `A_utxo`** — `intents.near`'s `ft_resolve_withdraw` sees the failed `ft_transfer` and
  credits the whole amount back to `A` (the sandbox runs it against the deployed code); `deliver` can
  run again once registered. The intent's own `storage_deposit` field pays from the signer's wNEAR
  inside `intents.near`, which `A` does not have, so the bot registers beforehand.
- **Minimum** — the route's `min_amount`, the connector's `min_withdraw_amount` (ZEC 100,000 zat,
  BTC 6,400 sat). Less waits in `A`, before and after the deadline; a settle then refunds only the
  ETH.
- **Connector paused** — the token waits on `A_utxo` and the bot retries. Nothing is lost.
- **Bitcoin's miner fee** is the withdraw contract's owner's rate on a 165 vB upper bound — 5 sat/vB,
  825 sat, until set otherwise (`set_fee_rate`, 1–30) — so no caller can make a user overpay. The
  relayer withdraws only while the mempool's half-hour rate is at or under it; a withdrawal anyone
  sends above it waits unconfirmed — delayed, not lost.

## Fees

Per payout, user side, from the live connector configs:

| Coin | Bridge (`withdraw_bridge_fee`) | Miner                | Total              |
| ---- | ------------------------------ | -------------------- | ------------------ |
| ZEC  | 10,000 zat                     | 10,000 zat (ZIP-317) | 20,000 zat ≈ $0.17 |
| BTC  | 400 sat                        | 825 sat at 5 sat/vB  | 1,225 sat ≈ $0.73  |

ZEC at $846.75, BTC at $59,938. POA charged 72,000 zat per ZEC payout ([verification.md](verification.md), G3).

The bots pay in NEAR, per payout: `deliver` ~0.0031, `withdraw` 0.0021, the relay 0.0012 and a gas
refund penalty ~0.002 — ~0.0084 NEAR ≈ $0.025; the first payout to an address adds 0.00125 for the
registration and ~0.00005 to create `A_utxo`. On the Hydration UTXO route the emitter's `fee` refills
the bots; on this path nothing does unless a fee is added. The swap (~0.0038 NEAR per tranche) is
left out.

## Control

Whoever can change a contract's code controls every account it signs for.

| Funds                    | Moved by                                              | Code changed by                            |
| ------------------------ | ----------------------------------------------------- | ------------------------------------------ |
| `A`'s, in `intents.near` | `intents-router.hydration-whm.near`                   | `hydration.sputnik-dao.near` only; no keys |
| `A_utxo`'s, on the token | `withdraw-zec` / `withdraw-btc` `.hydration-whm.near` | `hydration.sputnik-dao.near` only; no keys |

Trusted underneath: `v1.signer` (the MPC network), `intents.near` (custody and ledger), the token's
issuer, and the Omni connector — `rainbowbridge.sputnik-dao.near` administers it, its MPC holds the
coin's side, and `omni-relayer.bridge.near` is the only account allowed to sign withdrawals: a
dependency for the path to keep working, not for the funds to stay safe. POA is trusted for the ETH
rail — credits into `A` and refunds out of it.

## Router support

Hydration, the terms and the codec do not change. Generic over the coin: a new chain is a
`utxo-withdraw` chain module, its own deployment and one more route — no router change.

- **Route** — `set_utxo_route(token, Option<UtxoRoute>)`, view `utxo_routes()`; stored under its own
  key beside the router's state. `UtxoRoute { withdraw, path_prefix, address_prefixes, min_amount }`,
  e.g. `nep141:zec.omft.near → { withdraw-zec.hydration-whm.near, "zcash:v1:", ["t1", "t3"], 100000 }`;
  set by `intents-v2` 013 (ZEC) and 014 (nBTC).
- **`deliver` and `settle`** — the payout's reads also derive `A_utxo`, and the intent is
  `ft_withdraw(token, receiver A_utxo, no memo)`.
- **Address check** — by prefix only. The withdraw contract validates the checksum; an address it
  rejects leaves the token on `A_utxo`, so the SDK validates the address — the same base58check or
  bech32 decode the NTT UI does — before it builds the terms.
- **Event** — `intent_signed` carries `utxo_account` (`A_utxo`); `receiver` stays the address.
- **Router bot** — registers `A_utxo` on the token before a routed `deliver` or `settle`.
- **UTXO relayer** — scan's `GET /api/payouts?utxo=true&after=<ms>` as a second trigger beside
  Hydration's `WithdrawRequested`, into the same records and worker.
- **Scan** — `intent_v2_payouts` keeps `token`, `receiver` and `utxo_account`; the payout poller pairs
  the Zcash or Bitcoin transaction by recipient.

The route is chosen at payout time, so setting it applies to running trades too.

## Unverified

- The connector's `protocol_fee_rate` (5,000 on Bitcoin) is read as Omni's share of the bridge fee,
  not an addition to it.
- The extra derive's gas in `deliver` on mainnet — measured in the sandbox only.
