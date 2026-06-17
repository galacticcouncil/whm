# nintent

Near INTENT deposit notifier — a thin, always-on watcher for the WTT intent path. **Does not relay.**

It subscribes over a WebSocket RPC to the `IntentReceiver` on Ethereum and, for every
`IntentForwarded(intentId, asset, depositAddress, amount)` event (emitted when the intent relayer's
`redeem` unwraps the bridged WETH to native ETH and forwards it to a OneClick deposit address), pings
1Click:

```ts
OneClickService.submitDepositTx({ depositAddress, txHash });
```

so 1Click detects the deposit immediately instead of waiting on its own chain scan. The ops scripts
([`nirViaWtt.ts`](../../contracts/scripts/nirViaWtt.ts),
[`nirRelay.ts`](../../contracts/scripts/nirRelay.ts)) do this inline after relaying; `nintent` is the
equivalent for the live relayer ([`mrelayer` `app-intent`](../mrelayer/src/app-intent.ts)), which
relays but does not notify.

Push, not poll: viem's `watchContractEvent` over a `webSocket` transport opens an `eth_subscribe` log
subscription — no per-block `getLogs` polling. viem keepalive-pings the socket and reconnects +
re-subscribes on drop.

## Manual trigger

Public, no auth — anyone can fire a submission by hand (e.g. if the socket missed an event):

```sh
curl -X POST localhost:8080/api/submit \
  -H 'content-type: application/json' \
  -d '{"depositAddress":"0x…","txHash":"0x…"}'
# -> { "status": "...", "correlationId": "..." }
```

`GET /api/health` returns `{ "ok": true }`; `GET /api/status` reports uptime, the watched receiver,
and how many deposits have been submitted.

## Environment

| Variable          | Description                                           | Default  |
| ----------------- | ----------------------------------------------------- | -------- |
| `ETH_WSS`         | WebSocket Ethereum RPC (must support `eth_subscribe`) | Required |
| `INTENT_RECEIVER` | IntentReceiver proxy address on Ethereum              | Required |
| `PORT`            | HTTP API port                                         | `8080`   |
| `LOG_LEVEL`       | winston log level                                     | `info`   |

## Run

```sh
pnpm install                 # from repo root (workspace member)
cp .env.example .env         # fill ETH_WSS + INTENT_RECEIVER
npm run dev                  # esbuild watch + node --env-file=.env
```

## Docker

```sh
npm run build                # esbuild -> dist/index.js
npm run docker:build         # galacticcouncil/nintent:latest
npm run docker:deploy        # multi-arch buildx push
npm run docker:up            # docker stack deploy -c docker-compose.yml whm
```
