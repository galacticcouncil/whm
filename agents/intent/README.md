# intent

Everything off-chain the intents path needs that isn't VAA relaying. One image, one container per
app, the command names the entry point.

| App           | What it does                                                           |
| ------------- | ---------------------------------------------------------------------- |
| `app-quoter`  | Prices the destination relay fee, so the SDK can size `maxRelayFee`    |
| `app-relayer` | Tells 1Click a deposit landed, so an order resolves instead of sitting |

> The VAA relaying itself lives in [`agents/relayer`](../relayer/) (`intent` app) — it submits
> `processOrder`. `app-relayer` here is the 1Click leg, which touches no chain state.

## quoter

```
GET /relay-fee?chain=ethereum[&marginBps=][&gasLimit=]
  → { chain, feeAsset, feeRequested, gasLimit, gasPriceWei, costNativeWei, marginBps, gas }
GET /health          → { ok: true }
GET /api/status      → the modelled envelope, so a stale constant is visible without a quote
```

Amounts are decimal strings in wei. Native only: the fee is paid out of what `IntentReceiver`
delivers, and that is always native ETH — a `feeAsset` naming anything but `native` or WETH is
refused rather than answered in the wrong asset.

**It answers what the relayer will bill; the caller owns the headroom.** `marginBps` is per-request —
the SDK asks with `marginBps=2000` for its 20%. `FEE_MARGIN_BPS` defaults to `0` so a caller that
forgets to pass one gets the estimate, not a silently biased number.

The gas figure is derived from the call the relayer will build rather than configured:

```
gas = 21_000                  intrinsic
    + 16·nonzero + 4·zero     calldata, from the VAA envelope
    + 560_000                 execution, pinned from measurement

fee = gas × maxFeePerGas × (1 + marginBps)
```

Priced at `maxFeePerGas`, not the base fee — that is what the relayer bills, and quoting the base
fee instead leaves the caller's margin with nothing to cover.

Both VAAs have fixed-length payloads and fixed framing, so the envelope is computable before either
exists — only the guardian quorum is read live. Execution is pinned because it isn't derivable;
**re-pin it after an `IntentReceiver` or NTT upgrade**. Full reasoning, and what the measurements
were: [docs/intents/relay-fee.md](../../docs/intents/relay-fee.md).

`gasLimit` on the request replaces the model outright (and drops `gas` from the response, since the
breakdown would no longer describe what was priced). `ETH_GAS_LIMIT` does the same permanently.
Both are escape hatches — normal operation uses neither.

Extend to a new chain by implementing `ChainQuoter` ([src/apps/quoter/chains/](src/apps/quoter/chains/))
and registering it in `app.ts`.

## relayer

Watches `IntentReceiver.OrderProcessed` over `eth_subscribe` and calls 1Click's `submitDepositTx`
for each forward, deduped by `(txHash, depositAddress)`. viem reconnects and re-subscribes on drop;
a 30s heartbeat makes the outage and its recovery visible in the logs.

```
POST /api/submit { depositAddress, txHash }   # manual retry, bypasses the dedupe
GET  /api/status                              # socket target and how many deposits were submitted
```

## Environment

| Variable            | App     | Description                                                   | Default  |
| ------------------- | ------- | ------------------------------------------------------------- | -------- |
| `PORT`              | both    | HTTP port                                                     | `8080`   |
| `LOG_LEVEL`         | both    | winston level                                                 | `info`   |
| `ETH_RPC`           | quoter  | Ethereum RPC — fee estimate and the guardian set              | Required |
| `ETH_WORMHOLE_CORE` | quoter  | Wormhole core, for the guardian quorum                        | mainnet  |
| `ETH_GAS_LIMIT`     | quoter  | Escape hatch: replaces the modelled envelope                  | unset    |
| `FEE_MARGIN_BPS`    | quoter  | Margin when a request names none                              | `0`      |
| `ETH_WSS`           | relayer | Ethereum websocket — `OrderProcessed` arrives by subscription | Required |
| `INTENT_RECEIVER`   | relayer | `IntentReceiver` address to watch                             | Required |

## Development

```bash
pnpm install
pnpm --filter @whm/intent dev quoter     # esbuild watch + run one app (reads .env)
pnpm --filter @whm/intent dev relayer
```

## Production

```bash
pnpm --filter @whm/intent build          # → dist/<app>/app.js
pnpm --filter @whm/intent start:quoter
pnpm --filter @whm/intent start:relayer
```

## Docker

```bash
pnpm --filter @whm/intent build          # build dist first (Dockerfile copies it)
pnpm --filter @whm/intent docker:build
pnpm --filter @whm/intent docker:up      # docker stack deploy -c docker-compose.yml intent
```
