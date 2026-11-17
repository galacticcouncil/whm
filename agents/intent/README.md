# intent

Everything off-chain the intents path needs that isn't VAA relaying. One image, one container per
app, the command names the entry point.

| App           | What it does                                                           |
| ------------- | ---------------------------------------------------------------------- |
| `app-quoter`  | Prices the destination relay fee, so the SDK can size `maxRelayFee`    |
| `app-relayer` | Tells 1Click a deposit landed, so an order resolves instead of sitting |
| `app-router`  | Intents v2 on NEAR: has the router sign swaps, deliveries and refunds  |

> The VAA relaying itself lives in [`agents/relayer`](../relayer/) (`intent` and `intent-v2` apps)
> — they submit `processOrder`. `app-relayer` here is the 1Click leg, which touches no chain state.

## quoter

```
GET /relay-fee?chain=ethereum[&marginBps=][&gasLimit=]
  → { chain, feeAsset, feeRequested, gasLimit, gasPriceWei, costNativeWei, marginBps, gas }
GET /health          → { ok: true }
GET /api/status      → the modelled envelope, so a stale constant is visible without a quote
```

Amounts are decimal strings in wei. Native only: the fee is paid out of what the Ethereum receiver
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

One envelope serves every intents version, because it models the heavier call. v1's
`IntentReceiver.processOrder` carries two VAAs (the settlement and the instruction) and verifies two
signature sets; v2's `IntentForwarder.processOrder` carries one VAA, the instruction riding in its
transfer payload, and verifies one. So the quote is exact for v1 and an upper bound for v2 — a
slightly generous ceiling, while the relayer still claims what the real call costs.

Every VAA has a fixed-length payload and fixed framing, so the envelope is computable before any
exists — only the guardian quorum is read live. Execution is pinned because it isn't derivable;
**measure it again after an upgrade of either receiver or of NTT**. Full reasoning, and what the
measurements were: [docs/intents/relay-fee.md](../../docs/intents/relay-fee.md).

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

## router

The NEAR side of intents v2 ([docs/intents-v2/spec.md](../../docs/intents-v2/spec.md) §6–7). Every
`TICK_MS` it walks the terms scan's `intents-v2` app lists (`/api/terms`), reads `A`'s ETH and
destination balances on `intents.near`, and does at most one thing per set of terms:

| When                | Condition                                                         | Action                      |
| ------------------- | ----------------------------------------------------------------- | --------------------------- |
| before the deadline | the newest order is still priced, and its ETH has landed in `A`   | swap, through 1Click        |
| before the deadline | the destination balance reaches the terms' `minDelivery`          | deliver, on the solver relay |
| after the deadline  | any destination balance; then ETH from the router's `min_refund`  | deliver; refund             |
| after the deadline  | neither is left                                                   | drop the terms              |

A swap is `A`'s whole ETH up to the terms' `maxFillMultiplier` × the order's amount — the only size
the router accepts — quoted by 1Click to pay and refund `A`, signed by the router against the order's
VAA (from Wormholescan, by the id scan gives), and submitted to 1Click. The router checks everything;
the bot only decides when to ask, from the same rules ([src/apps/router/plan.ts](src/apps/router/plan.ts)).

It stores nothing. What is left to do is `A`'s balances, so a restart picks up where it was, and a
payout signed twice can only execute once. The router's params are read once at startup — restart
the bot after the DAO changes them.

The bot account's key must be **full-access**: every router call attaches the 1 yocto `v1.signer`
takes, and a function-call key cannot attach a deposit. Hold only gas money on it.

```
GET /api/status   → each set of terms: A, its balances, the last action and error
```

## Environment

| Variable            | App     | Description                                                   | Default  |
| ------------------- | ------- | ------------------------------------------------------------- | -------- |
| `PORT`              | all     | HTTP port                                                     | `8080`   |
| `LOG_LEVEL`         | all     | winston level                                                 | `info`   |
| `ETH_RPC`           | quoter  | Ethereum RPC — fee estimate and the guardian set              | Required |
| `ETH_WORMHOLE_CORE` | quoter  | Wormhole core, for the guardian quorum                        | mainnet  |
| `ETH_GAS_LIMIT`     | quoter  | Escape hatch: replaces the modelled envelope                  | unset    |
| `FEE_MARGIN_BPS`    | quoter  | Margin when a request names none                              | `0`      |
| `ETH_WSS`           | relayer | Ethereum websocket — `OrderProcessed` arrives by subscription | Required |
| `INTENT_RECEIVER`   | relayer | `IntentReceiver` address to watch                             | Required |
| `SCAN_API`          | router  | scan's `intents-v2` app                                       | Required |
| `RPC_NEAR`          | router  | NEAR RPC                                                      | Required |
| `ROUTER`            | router  | `IntentRouter` account                                        | Required |
| `NEAR_ACCOUNT`      | router  | The bot's account                                             | Required |
| `NEAR_PRIVKEY`      | router  | Its full-access key, `ed25519:…`                              | Required |
| `ONECLICK_KEY`      | router  | 1Click partner key                                            | Required |
| `GRACE_DAYS`        | router  | How long past their deadline terms stay listed                | `30`     |
| `TICK_MS`           | router  | Pass interval                                                 | `30000`  |

## Development

```bash
pnpm install
pnpm --filter @whm/intent dev quoter     # esbuild watch + run one app (reads .env)
pnpm --filter @whm/intent dev relayer
pnpm --filter @whm/intent dev router
pnpm --filter @whm/intent test           # the router's decisions
```

## Production

```bash
pnpm --filter @whm/intent build          # → dist/<app>/app.js
pnpm --filter @whm/intent start:quoter
pnpm --filter @whm/intent start:relayer
pnpm --filter @whm/intent start:router
```

## Docker

```bash
pnpm --filter @whm/intent build          # build dist first (Dockerfile copies it)
pnpm --filter @whm/intent docker:build
pnpm --filter @whm/intent docker:up      # docker stack deploy -c docker-compose.yml intent
```
