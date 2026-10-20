# SCHEMA — UTXO deposit

The order and its encodings for depositing a UTXO coin onto Hydration. Design and rationale:
[spec.md](spec.md). Per-chain addresses and values: [zcash.md](zcash.md).

## Message topology

```text
app         DepositMsg (JSON) ─▶ connector view / Omni API ─▶ deposit address
user        plain payment to that address, on the coin's chain
NEAR        Omni relayer: verify_deposit_v2(tx proof, DepositMsg)
              → safe_mint(recipient_id = ntt-<token>, amount, safe_deposit.msg)
              → ntt-<token>.ft_on_transfer(sender = connector, amount, msg = TransferMsg)
              → lock + publish NTT transfer to Hydration (chain 73)
Hydration   our `ntt` relayer delivers; the asset is minted to TransferMsg.recipient
```

## 1. The order — `DepositMsg`

NEAR-side data, never on the coin's chain:

```json
{
  "recipient_id": "ntt-<token>.hydration-whm.near",
  "safe_deposit": { "msg": "{\"recipient_chain\":73,\"recipient\":\"0x<Hydration H160>\",\"refund_to\":\"hydration.sputnik-dao.near\"}" },
  "refund_address": "<address on the coin's chain>"
}
```

| Field                     | Meaning                                                                       |
| ------------------------- | ----------------------------------------------------------------------------- |
| `recipient_id`            | our NTT manager for the coin — the `ft_transfer_call` receiver                |
| `safe_deposit.msg`        | the `msg` `ft_on_transfer` receives: our `TransferMsg`, as a JSON string      |
| `refund_address`          | the coin's chain — Omni's refund when the manager refuses before the mint     |

### `TransferMsg` — the NTT manager's `msg`

| Field             | Type         | Meaning                                                               |
| ----------------- | ------------ | --------------------------------------------------------------------- |
| `recipient_chain` | `u16`        | Wormhole chain id — 73, Hydration                                     |
| `recipient`       | hex string   | the Hydration EVM address (H160) the asset is minted to               |
| `refund_to`       | `AccountId`  | NEAR account a failed publish refunds to — `hydration.sputnik-dao.near`, registered on the token |

The connector passes `msg` through unchanged — it rewrites only a `utxo_id` key
(`inject_utxo_id_in_msg`), which `TransferMsg` has none of.

## 2. Order → deposit address

```
path    = sha256(json(DepositMsg))                     over the exact JSON — field order and spacing included
address = the chain's address for the connector's MPC key derived at `path` (v1.signer)
```

One order, one address. `verify_deposit_v2` recomputes it from the order and requires the payment
to go to it.

## 3. Getting the address

Never derived by the app — the hash is over the exact JSON:

- `POST https://mainnet.api.bridge.nearone.org/api/v3/utxo/get_user_deposit_address`
  `{ chain, recipient, safe_deposit: { msg }, refund_address? }` → `{ address }` (`@omni-bridge/core`
  `getUtxoDepositAddress`) — registers the order for Omni's relayer with a NEAR transaction of its own
  **[V 2026-10-17: a nonce clash surfaced as `NEAR transaction failed … get_user_deposit_address`]**;
  retry a 5xx;
- or the connector's view `get_user_deposit_address({ deposit_msg })` with the same `DepositMsg` —
  computes the address, registers nothing. `agents/utxo` (`/api/deposit/:chain/:recipient`) calls both
  and refuses a mismatch **[V 2026-10-17: same address from both, with and without `refund_address`]**.

## 4. Refund calls

| Failure                                | Call                                                              | Who                     |
| -------------------------------------- | ----------------------------------------------------------------- | ----------------------- |
| Manager refuses before the mint        | `connector.request_refund` (NEAR deposit) → after `refund_timelock_sec` (2 days) `execute_refund` → signing | anyone |
| Publish fails after the manager accepted | the manager's own refund: `token.ft_transfer(refund_to, amount)`; emits `transfer_failed` (Hydration recipient, amount) | the manager |
