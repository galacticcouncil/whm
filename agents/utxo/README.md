# utxo

The off-chain side of UTXO withdrawals from Hydration — ZEC to Zcash today
([docs/near-utxo/withdraw/spec.md](../../docs/near-utxo/withdraw/spec.md)). One image, one container per app;
the command names the entry point.

| App       | What it does                                                                        |
| --------- | ----------------------------------------------------------------------------------- |
| `api`     | Which NEAR account a destination address withdraws through — the arguments for `send` |
| `relayer` | Withdraws each derived account's balance to its destination address                 |

> Completing the NTT settlement into the derived account is the `ntt-near` app in
> [`agents/relayer`](../relayer/) — Wormhole relaying lives there. This agent only withdraws.

Per-coin logic lives in [src/chains/](src/chains/) — the coin's `UtxoWithdraw` contract, a golden
vector, its address codec and miner fee. A new coin is a chain file, an entry in `CHAINS` and a route.

## api

```
GET /api/withdraw/:chain/:address                     address on the coin's chain
  → { chain, address, account, send: { destination, nearAccount } }
GET /api/deposit/:chain/:recipient?refund=<address>   recipient on Hydration
  → { chain, recipient, refund, address }
GET /api/health      → { ok: true }
GET /api/status      → { chains }
```

**Withdraw.** `account` is the implicit NEAR account `A` that `address` derives under the chain's
contract (`path_of`, then `v1.signer.derived_public_key`, domain 1). `send` is what the coin's
emitter `send` takes beside the amount — `destination` (the address bytes) and `nearAccount`
(`bytes32`). 400 for an address the emitter would refuse, 404 for an unknown chain. Each chain's
golden vector is checked at startup.

**Deposit.** `address` is the chain's Omni connector's address for an order paying our NTT manager
with `TransferMsg { recipient_chain: 73, recipient, refund_to: hydration.sputnik-dao.near }`. The
order is registered with the Omni Bridge API — that is what lets Omni's relayer finalize the deposit —
and the address is checked against the connector's own view of it; a mismatch is a 502, never an
address. `refund` (the coin's chain) is part of the order and changes the address; the app should ask
for it. `recipient` is a `0x` Hydration EVM address.

## relayer

One record per `WithdrawRequested`, from every route's emitter, in Redis:

- **Watch** — `EVM.Log` out of Hydration's `System.Events` on finalized blocks, as scan reads it: a
  `send` made as a substrate extrinsic has no ethereum receipt, so eth_getLogs would miss it. The
  event's `nearAccount` must be what its `destination` derives, or the record closes as `mismatch`.
- **Withdraw** — every 30 s, for each open record: once `A` holds at least `min_withdraw_amount`,
  create `A` (once, 1 yocto), pick the best-fit connector coin, have the chain's contract sign the
  withdrawal of the whole balance, relay the delegate.
- **Close** — when `A`'s balance has left through the connector; records of the same `A` close
  together. Any failure leaves the funds in `A`, and the next pass retries with a fresh coin. A
  record open over an hour is logged once an hour.

Routes — one per coin, each with its own emitter — are in
[config.ts](src/apps/relayer/config.ts); the app refuses to start on a blank one. Redis keys:
`utxo:cursor`, `utxo:<chain>:<sequence>`, `utxo:open`.

## Configuration

| Variable                  | App     | Description                                   | Default                         |
| ------------------------- | ------- | --------------------------------------------- | ------------------------------- |
| `RPC_NEAR`                | both    | NEAR RPC                                      | `https://free.rpc.fastnear.com` |
| `RPC_HYDRATION_WSS`       | relayer | Hydration websocket                           | required                        |
| `NEAR_ACCOUNT_ID`         | relayer | Signing account — pays gas, 1 yocto, new `A`s | required                        |
| `NEAR_PRIVKEY`            | relayer | Its `ed25519:` secret key                     | required                        |
| `REDIS_HOST/PORT`         | relayer | Redis                                         | `localhost` / `6379`            |
| `REDIS_PREFIX`            | relayer | Key prefix — load-bearing                     | `utxo`                          |
| `CONFIRMATIONS_HYDRATION` | relayer | Blocks behind finalized                       | `0`                             |
| `PORT`                    | both    | HTTP port                                     | `8080`                          |

A withdrawal pages the connector's whole coin set (~50 views for Zcash) — use a paid NEAR RPC in
production to stay clear of 429s.
