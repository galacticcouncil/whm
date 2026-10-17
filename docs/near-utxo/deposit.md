# UTXO deposit — BTC and ZEC → Hydration through NEAR NTT

How a user holding BTC on Bitcoin or ZEC on Zcash gets it onto Hydration with **one transfer from
their own wallet**, by composing Omni's UTXO connectors with our NEAR NTT manager. The manager stays
token-agnostic: it only sees `ft_transfer_call(receiver = ntt-<token>, msg = TransferMsg)`.

Researched 2026-09-28. **[V]** verified in code, on chain or by a live call; **[I]** inferred.

## Summary

- **One plain transfer.** The user pays a deposit address on Bitcoin / Zcash — no NEAR account, no
  NEAR tokens, no gas anywhere. The address itself carries the Hydration recipient; everything after
  the payment is relayed.
- **Two routes, one per Omni connector:** ZEC → `zec.omft.near`, BTC → `nbtc.bridge.near`. Each
  gets its own NTT deployment.
- **`btc.omft.near` is not the BTC route.** It is the NEAR Intents BTC, a different token that
  lands in `intents.near` (see [Other omft tokens](#other-omft-tokens)).

## The user flow

1. Opens our app (the Hydration UI), picks **Deposit BTC** or **Deposit ZEC**.
2. Gives two addresses:
   - their **Hydration account** — filled from the connected wallet;
   - a **refund address** on Bitcoin / Zcash — used only if the deposit fails. The app must ask:
     nothing about the sender is known before they pay.
3. Gets a **deposit address** and QR code (`bc1q…` / `t1…`), unique to this order.
4. Sends BTC / ZEC to it from any wallet. Shielded ZEC is de-shielded to the `t1` address in the
   same send (Zashi does this).
5. Waits; the funds appear on Hydration.

|               | Bitcoin                               | Zcash       |
| ------------- | ------------------------------------- | ----------- |
| Minimum       | 2,500 sat                             | 0.001 ZEC   |
| Confirmations | 2 for deposits up to 1 BTC (~20 min)  | not checked |
| Then          | minutes: NEAR, Wormhole, Hydration    | same        |
| On failure    | refund to the refund address after 2 days | same    |

## How it works

```text
app ──(order JSON, read-only view)──▶ NEAR connector        returns bc1q… / t1… for this order
user ──(plain payment)──▶ Bitcoin / Zcash                    a normal transfer to that chain
Omni relayer ──(tx proof + same order)──▶ NEAR connector    verifies, mints, ft_transfer_call(ntt, msg)
ntt-<token> ──(lock + publish)──▶ Wormhole ──▶ our `ntt` relayer ──▶ Hydration mints to the user
```

| Who               | Does                                                                          | Pays                             |
| ----------------- | ----------------------------------------------------------------------------- | -------------------------------- |
| Our app           | gets the order's deposit address from the Omni Bridge API (no transaction)    | —                                |
| User              | pays it on Bitcoin / Zcash                                                    | the native network fee           |
| Omni relayer      | proves the payment on NEAR (`verify_deposit_v2`), mints into our NTT manager  | NEAR gas + ~0.0012 NEAR storage  |
| NTT manager       | locks and publishes the Wormhole message                                      | —                                |
| Our `ntt` relayer | delivers on Hydration; the asset is minted to the user                        | Hydration gas                    |

### The address is the order

**[V]** Omni's `satoshi-bridge` (<https://github.com/Near-One/btc-bridge>):

- The **order** is a `DepositMsg` — NEAR-side data, never on the Bitcoin / Zcash chain:

  ```json
  {
    "recipient_id": "ntt-btc.<parent>.near",
    "safe_deposit": { "msg": "{\"recipient_chain\":73,\"recipient\":\"0x<Hydration H160>\",\"refund_to\":\"hydration.sputnik-dao.near\"}" },
    "refund_address": "bc1…"
  }
  ```

  `recipient_id` is our NTT manager; `safe_deposit.msg` is the `msg` its `ft_on_transfer` receives —
  our `TransferMsg`. Three destinations on three chains: `recipient` on Hydration (the normal path),
  `refund_address` on Bitcoin / Zcash (Omni's refund, below), `refund_to` on NEAR (our manager's
  refund, below).
- **The address is derived from it:** `sha256(json(DepositMsg))` is the derivation path of an MPC key
  held by NEAR's signer network (`v1.signer`). One order, one address.
- **It cannot be redirected:** `verify_deposit_v2` checks the transaction against the connector's
  light client, recomputes the address from the order and requires the payment to go to it. A
  different recipient is a different address.
- That is Omni's custody: the BTC / ZEC sits at MPC-controlled addresses and backs the NEAR token.

For us:

- The app takes the address from the Omni API (`POST
  https://mainnet.api.bridge.nearone.org/api/v3/utxo/get_user_deposit_address`, `bridge-sdk-js`) or
  the connector view — never derives it: the hash is over the exact JSON.
- The relayer needs the whole order, not just the address. The `POST` presumably registers it for
  their relayer **[I]**.
- **Refunds depend on where a deposit fails** **[V `deposit.rs` `safe_mint_callback`,
  `is_refund_required`; `bridge.rs`]**:
  - **Our manager refuses** (paused, over the outbound limit, bad `msg`, out of gas) → `ft_on_transfer`
    panics, `safe_mint` reports 0 used, and the connector burns the mint without adding the coin to
    its reserve. The coin stays at the deposit address and goes back to the order's `refund_address`:
    `request_refund` (anyone, with a NEAR deposit), then `execute_refund` after `refund_timelock_sec`
    (2 days, anyone), then signing (open to anyone for refunds). Whether Omni's relayer runs these
    steps itself is not verified **[I]**.
  - **Our manager accepted, then the Wormhole publish failed** — only possible with a non-zero
    `message_fee` → `safe_mint` already reported the whole amount used, so the connector counts the
    deposit as done and no Zcash refund ever happens. Our manager refunds `zec.omft.near` on NEAR to
    `TransferMsg.refund_to`, or to the sender — Omni's connector, where it is a balance attributed to
    no one — without it. Hence `refund_to` in every order (below).

## The two routes

**[V]** on mainnet:

|                  | BTC                            | ZEC                               |
| ---------------- | ------------------------------ | --------------------------------- |
| Connector        | `btc-connector.bridge.near`    | `zcash-connector.bridge.near`     |
| Light client     | `btc-client.bridge.near`       | `zcash-client.bridge.near`        |
| NEAR token       | `nbtc.bridge.near`, 8 dp       | `zec.omft.near` (nbtc code), 8 dp |
| NTT manager      | `ntt-btc.<parent>.near`        | `ntt-zec.<parent>.near`           |
| Migration        | `near-ntt-btc` — to write      | `near-ntt-zec`                    |
| Token storage    | 0.00125 NEAR, open             | 0.00125 NEAR, open                |
| Bridge fee (safe deposit) | **[I]** — config `fee_min` 400 sat | none **[V in code]**   |
| Deposit address check | `bc1qvxag…` for an `ntt-btc` order | `t1LdHrV7…` for an `ntt-zec` order |

Each Hydration asset is backed by exactly one NEAR token ([near-ntt spec § Hub](../near-ntt/spec.md#hub)): the BTC asset by nBTC,
never also by `btc.omft.near`.

## What the NTT manager must guarantee

| Requirement | Why | Status |
| --- | --- | --- |
| Registered on the token | `safe_mint` burns the mint if the receiver is not | Step 003 |
| **Panic or return 0** from `ft_on_transfer` | the connector counts a partial "unused" as success and strands the rest **[V]** | Holds: both tokens are 8 dp, so trim dust is 0 — the Hydration assets must have ≥ 8 dp |
| Fit the gas `safe_mint` forwards | a `NotEnoughGas` panic burns the mint → refund after 2 days | **ZEC verified** in the sandbox on `zec.omft.near`'s mainnet code: `safe_mint` at the connector's 90 TGas (`GAS_FOR_MINT_CALL`) publishes and reports the whole amount used (`zec_connector_safe_mint_publishes`). BTC: to measure |
| A failed publish refunds someone reachable | the publish runs after `ft_on_transfer` returned 0, so the connector has counted the mint as consumed — its `request_refund` path does not fire, and a plain `ft_transfer` back to the connector credits no one | Every order sets `TransferMsg.refund_to = hydration.sputnik-dao.near`, registered on `zec.omft.near` (tx `7sXhAdihPgRztpXj9kK7Vy1SZarWFuCWZL1uRXtmgZsF`, 2026-10-17) — an unregistered `refund_to` would fall back to the connector's `claimable` |

## Resolved

- **Omni's relayer finalizes safe deposits automatically** — ZEC deposits reach Hydration through this
  route in production.
- **Our `ntt` relayer: the NEAR → Hydration route** — built (`agents/relayer`, ZEC and NEAR routes).
- **`safe_mint` gas forwarded to `ft_on_transfer`** — ZEC verified (see the table). The connector
  rewrites `msg` only where it has a `utxo_id` key (`inject_utxo_id_in_msg`); `TransferMsg` has none,
  so it arrives as sent.
- **`refund_to` for a deposit-address user.** The user has no NEAR account, so every order names our
  DAO, `hydration.sputnik-dao.near`, registered on `zec.omft.near`. A publish that fails after the
  manager accepted then refunds to the DAO, which pays the user back by a Transfer proposal — the
  `transfer_failed` event names the Hydration recipient and the amount.

## Runbook — a Wormhole `message_fee` on NEAR

Every publish is fail-closed while the core's `message_fee` is 0 ([near-ntt spec](../near-ntt/spec.md),
"Message fee"). If Wormhole governance sets one (a `SetMessageFee` governance VAA submitted to
`contract.wormhole_crypto.near`):

1. **Pause `ntt-zec` (and `ntt-near`)** — owner, a DAO proposal. A paused manager publishes nothing:
   new deposits are refused before the mint and go back to their `refund_address` on Zcash, and no
   outbound publish can fail.
2. **Upgrade** the manager to pay the fee on publish.
3. **Unpause.**

Between the fee going live and the pause, a deposit whose publish fails refunds to the DAO
(`refund_to`) — a manual refund, never a loss. Watch `message_fee()` on the core so the pause starts
early.

## Open

1. **BTC** — the `near-ntt-btc` migration (token `nbtc.bridge.near`), the Hydration asset + BURNING
   manager, the `set_ntt_minter` referendum; measure `safe_mint` gas into the manager; read the fee
   path for BTC safe deposits.

## Other omft tokens

Not a one-transfer route today:

- **[V]** The other `*.omft.near` tokens (PoA, `omni-token`) mint **into `intents.near`**, not onto an
  account. Reaching the manager takes a second NEAR step: `intents.near.ft_withdraw(…, msg)`, which
  becomes `ft_transfer_call`. A per-user forwarder with a crank could do it (one user signature, the
  crank pays gas) — not built.
- **[V]** 1Click delivers onto a NEAR account with a message (`customRecipientMsg`, marked
  experimental) only for ZEC; every other omft asset arrives as an intents balance. A failed call
  refunds into 1Click's intents account, not the user.
- **[V]** `btc.omft.near` / `eth.omft.near` allow `storage_deposit` only by `omft.near`, so our
  manager cannot register itself there.
- **[V]** Decimals follow the native asset (SOL 9, ETH 18, XRP 6): > 8 dp means trim dust, returned
  as unused — fine through `ft_withdraw` (credited back), not through the connectors.
- A failed publish refunds by plain `ft_transfer` to `refund_to`, or `sender_id` without one. From
  `intents.near` a refund to the sender is stranded (a plain transfer there credits no one), so the
  `ft_withdraw` `msg` must name the user's own NEAR account in `refund_to`, registered on the token —
  a refund it cannot take is credited to `claimable[intents.near]`. Only reachable if the Wormhole
  `message_fee` becomes non-zero.
