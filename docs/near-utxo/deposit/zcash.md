# Zcash — UTXO deposit

ZEC from Zcash onto Hydration. What is specific to Zcash; the flow and the order are chain-agnostic
([spec.md](spec.md), [schema.md](schema.md)).

**[V]** verified in code, on chain or by a live call; **[I]** inferred.

## Route

**[V]** on mainnet:

|                       |                                                         |
| --------------------- | ------------------------------------------------------- |
| Connector             | `zcash-connector.bridge.near`                           |
| Light client          | `zcash-client.bridge.near`                              |
| NEAR token            | `zec.omft.near` (`nbtc` code), 8 dp                     |
| NTT manager           | `ntt-zec.hydration-whm.near` — migration `near-ntt-zec` |
| Token storage         | 0.00125 NEAR, open                                      |
| Bridge fee (safe deposit) | none **[V in code]**                                |
| Deposit address check | `t1LdHrV7…` for an `ntt-zec` order                      |

## For the user

|               |                                                                                  |
| ------------- | -------------------------------------------------------------------------------- |
| Deposit address | `t1…`, unique to the order                                                     |
| Minimum       | 0.001 ZEC                                                                        |
| Confirmations | not checked                                                                      |
| Then          | minutes: NEAR, Wormhole, Hydration                                               |
| On failure    | refund to the refund address after 2 days                                        |

Shielded ZEC is de-shielded to the `t1` address in the same send (Zashi does this).

## Manager guarantees

| Requirement                                 | Status                                                                                       |
| ------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Registered on the token                     | step 003 of `near-ntt-zec`                                                                   |
| Panic or return 0 from `ft_on_transfer`     | holds: `zec.omft.near` and the Hydration ZEC asset are both 8 dp, so trim dust is 0           |
| Fit the gas `safe_mint` forwards            | **verified** in the sandbox on `zec.omft.near`'s mainnet code: `safe_mint` at the connector's 90 TGas (`GAS_FOR_MINT_CALL`) publishes and reports the whole amount used (`zec_connector_safe_mint_publishes`) |
| A failed publish refunds someone reachable  | `refund_to = hydration.sputnik-dao.near`, registered on `zec.omft.near` (tx `7sXhAdihPgRztpXj9kK7Vy1SZarWFuCWZL1uRXtmgZsF`, 2026-10-17) — an unregistered `refund_to` would fall back to the connector's `claimable` |

## Order example

```json
{
  "recipient_id": "ntt-zec.hydration-whm.near",
  "safe_deposit": { "msg": "{\"recipient_chain\":73,\"recipient\":\"0x<Hydration H160>\",\"refund_to\":\"hydration.sputnik-dao.near\"}" },
  "refund_address": "t1…"
}
```

## Resolved

- **Omni's relayer finalizes safe deposits automatically** — ZEC deposits reach Hydration through this
  route in production.
- **Our `ntt` relayer: the NEAR → Hydration route** — built (`agents/relayer`, ZEC route).
- **`safe_mint` gas forwarded to `ft_on_transfer`** — verified (see the table).
- **`refund_to`** — the DAO, registered on `zec.omft.near`.
- **1Click** delivers ZEC onto a NEAR account with a message (`customRecipientMsg`, experimental) —
  the one omft asset it does this for; not used by this route.
