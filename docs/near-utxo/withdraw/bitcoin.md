# Bitcoin — UTXO withdraw

nBTC from NEAR to a Bitcoin address through Omni's Bitcoin connector. What is specific to Bitcoin; the
contract and the relayer are chain-agnostic ([spec.md](spec.md), [schema.md](schema.md)).

Today it withdraws the intents router's deliveries only ([intents-v2 payout](../../intents-v2/payout.md)):
there is no Hydration emitter for BTC until a BTC NTT exists.

**[V]** verified in code, on chain or by a live call; **[I]** inferred.

## Constants

| Name           | Value                                                               |
| -------------- | ------------------------------------------------------------------- |
| `UtxoWithdraw` | `withdraw-btc.hydration-whm.near`, `chain: Bitcoin` (`utxo-withdraw-btc`) |
| Token on NEAR  | `nbtc.bridge.near` (8 dp) — the connector's `nbtc_account_id`       |
| Connector      | `btc-connector.bridge.near`, `chain: BitcoinMainnet`                |
| Minimum        | 6,400 sat — the connector's `min_withdraw_amount`                   |
| Miner fee      | the owner's rate × 165 vB — 825 sat at the default 5 sat/vB ([Fee](#fee)) |

## Addresses

```
terms   = a Bitcoin mainnet address, lowercase
          1… P2PKH, 3… P2SH            base58check, 21 bytes, version 0x00 / 0x05
          bc1q… P2WPKH / P2WSH          SegWit v0, bech32, 20- or 32-byte program
          bc1p… P2TR                    SegWit v1, bech32m, 32-byte program
path    = "bitcoin:v1:" + address      exact string
```

Lowercase only: the address string is the derivation path, so `bc1q…` and `BC1Q…` would be two
accounts for one address. Testnet addresses, witness versions past Taproot and a bech32 checksum on a
Taproot address are refused **[V, BIP-173/350 vectors in the contract's tests]**.

**Golden vector** (checked by the relayer at startup, derived by the live `v1.signer`):
`bc1qp42j7hn3lup7gck6y6eks6x2lmnp800t6gy7sk` (the connector's change address) → key
`5YvwpUX3u6VQim3tgSrZGR5oTfU1eUXKQ6CnNA3p1U8S` →
`A = 439cbfaea9968fe55d92df661ab036e44ac20e1b346ceacfea1eb4a2b476616b`.

## Connector

**[V]** live `btc-connector.bridge.near` config, 2026-11-24:

|                       |                                                         |
| --------------------- | ------------------------------------------------------- |
| Minimum withdrawal    | 6,400 sat                                               |
| Bridge withdraw fee   | 400 sat flat (`protocol_fee_rate` 5,000 — Omni's share **[I]**) |
| Miner fee range       | 100 – 5,000 sat                                         |
| Minimum change        | 537 sat                                                 |
| Inputs per withdrawal | ≤ 23                                                    |
| Pending tx timeout    | 86,400 s                                                |
| Change address        | `bc1qp42j7hn3lup7gck6y6eks6x2lmnp800t6gy7sk` (P2WPKH)   |

**Worked example** (the contract's tests): `A` holds 0.001 BTC, to a Taproot address, from a
0.01 BTC coin.

|                                  | sat                                   |
| -------------------------------- | ------------------------------------- |
| `amount` = balance(A)            | 100,000                               |
| bridge fee                       | 400                                   |
| miner fee                        | 825                                   |
| user output → the user's address | 98,775                                |
| change → Omni's change address   | 1,000,000 − 98,775 − 825 = 900,400    |

## Fee

Bitcoin has no protocol rule like Zcash's ZIP-317: its fee is a market price per virtual byte. The
contract's owner sets the rate; no caller names it, so none can make a user overpay — `withdraw` is
permissionless, and a caller-chosen fee would let anyone spend a user's coins on the connector's
5,000-sat maximum.

- **Rate** — `set_fee_rate(sat_per_vb)`, owner only, 1–30 (30 × 165 = 4,950, inside the connector's
  range); 5 until set (`chains/bitcoin.rs` `DEFAULT_FEE_RATE`). Stored beside the state, so setting
  it needs no `migrate`; `get_params().fee_rate` reports it, and it prices the next withdrawal.
- **Size** an upper bound, 165 vB: 11 overhead, 68 for the connector's P2WPKH coin, 43 per output —
  the largest standard kind (P2WSH, P2TR) — for the user's output and the change. A withdrawal to a
  `bc1q…` address is ~141 vB, so it pays a little over the rate.

Above the rate a withdrawal waits unconfirmed until the mempool clears — delayed, not lost. The
relayer reads the rate before each withdrawal and withdraws only while mempool.space's half-hour rate
is at or under it; a stranger can only send one early. Spikes are what the waiting is for; the rate
is for lasting shifts — after the handover, a DAO proposal.

User side per withdrawal at the default rate: 400 + 825 = 1,225 sat ≈ $0.73 at $59,938; at 2 sat/vB,
400 + 330 = 730 sat ≈ $0.44.

## Open

1. **Deploy** — `utxo-withdraw-btc`, then `intents-v2` 014 (the router's nBTC route), then restart
   the relayer: it checks `withdraw-btc`'s golden vector at startup.
2. **A canary** — a small nBTC payout to a `bc1q…` address; the coin set and the connector's
   acceptance of our `Withdraw` message are verified on Zcash only.
3. **Hydration** — a BTC emitter (variable-length destinations) and a BTC NTT, for withdrawals from
   Hydration itself.
