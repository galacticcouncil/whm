# BTC and ZEC → Hydration through NEAR NTT

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
    "safe_deposit": { "msg": "{\"recipient_chain\":73,\"recipient\":\"0x<Hydration H160>\"}" },
    "refund_address": "bc1…"
  }
  ```

  `recipient_id` is our NTT manager; `safe_deposit.msg` is the `msg` its `ft_on_transfer` receives.
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
- Refunds go through the same order: if our manager refuses (paused, over the outbound limit, not
  registered, out of gas), the mint is burned and `request_refund` pays the refund address after
  `refund_timelock_sec` (2 days).

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

Each Hydration asset is backed by exactly one NEAR token (spec.md § Hub): the BTC asset by nBTC,
never also by `btc.omft.near`.

## What the NTT manager must guarantee

| Requirement | Why | Status |
| --- | --- | --- |
| Registered on the token | `safe_mint` burns the mint if the receiver is not | Step 003 |
| **Panic or return 0** from `ft_on_transfer` | the connector counts a partial "unused" as success and strands the rest **[V]** | Holds: both tokens are 8 dp, so trim dust is 0 — the Hydration assets must have ≥ 8 dp |
| Fit the gas `safe_mint` forwards | a `NotEnoughGas` panic burns the mint → refund after 2 days | **To verify**, per connector: the manager needs ~55 TGas; `safe_mint` gets 90 TGas on ZEC |

## Open

1. **Omni's relayer finalizes safe deposits automatically** — **[I]**, confirm with Omni.
2. **Our `ntt` relayer: a NEAR → Hydration route** — not built.
3. **`safe_mint` gas forwarded to `ft_on_transfer`** — measure per connector.
4. **BTC deployment** — `near-ntt-btc` migration (token `nbtc.bridge.near`), Hydration asset +
   BURNING manager, `set_ntt_minter` referendum.
5. **Bridge fee on BTC safe deposits** — read the fee path for BTC.
6. **Deposit screen** in the app, calling the Omni API.

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
- A failed publish refunds by plain `ft_transfer` to `sender_id`. From `intents.near` that is
  stranded (a plain transfer there credits no one). Only reachable if the Wormhole `message_fee`
  becomes non-zero; the fix would be an optional `refund_to` in `TransferMsg`.
