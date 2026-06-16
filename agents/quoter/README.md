# quoter

Stateless HTTP service that quotes the destination **relay fee** for the Hydration/Moonbeam → out
WTT intent path. The UI uses it to size `maxRelayFee` before bridging; `mrelayer` uses it to pick the
`feeRequested` for `IntentReceiver.redeem(vaa, feeRequested)`. It only prices — no keys, no VAAs, no
submission. Background: [relay-fee.md](../../docs/intents/relay-fee.md).

## API

```
GET /relay-fee?chain=ethereum[&gasLimit=][&marginBps=]                    # native ETH (feeAsset omitted ⇒ native, no FX)
GET /relay-fee?chain=ethereum&feeAsset=0x<erc20>[&gasLimit=][&marginBps=] # ERC20 (degraded path)
  → { chain, feeAsset, feeRequested, gasLimit, gasPriceWei, costNativeWei, marginBps }
```

`feeRequested` = `gasLimit × gasPrice`, converted to `feeAsset` (ERC20 via Hydration's TradeRouter —
see [galacticcouncil-sdk.md](../../docs/galacticcouncil-sdk.md)), plus margin. Decimal strings in the
asset's smallest unit. `GET /health` → `{ ok: true }`.

Extend to a new chain by implementing `ChainQuoter` ([src/chains/](src/chains/)) and registering it.

## Environment Variables

| Variable                   | Description                                                               | Default  |
| -------------------------- | ------------------------------------------------------------------------- | -------- |
| `PORT`                     | HTTP port                                                                 | `8080`   |
| `FEE_MARGIN_BPS`           | Margin over raw gas cost (2000 = +20%)                                    | `2000`   |
| `HYDRATION_RPC`            | papi WS endpoint (TradeRouter price source)                               | Required |
| `ETH_RPC`                  | Ethereum RPC (gas price)                                                  | Required |
| `ETH_WRAPPED_NATIVE`       | WETH address (`feeAsset` == this or `native` ⇒ no FX)                     | Required |
| `ETH_GAS_LIMIT`            | Default gas limit for the relay cost (overridable per request)            | `150000` |
| `ETH_GAS_PRICING_ASSET_ID` | Hydration (Omnipool) asset id used to price ETH gas (`20`=WETH, `34`=ETH) | Required |

> ERC20 → Hydration asset id is resolved from `@galacticcouncil/xc-cfg` route configs.
> `ETH_GAS_PRICING_ASSET_ID` (and ERC20 ids) must be the **TradeRouter-tradeable** registry id — the
> xc-cfg WETH route id (`1000189`) is rejected by the router (`not supported asset`).

## Development

```bash
pnpm install
pnpm --filter @whm/quoter dev     # esbuild watch + run (reads .env)
./example.sh                       # curl /relay-fee (service must be running)
```

## Production

```bash
pnpm --filter @whm/quoter build   # → dist/index.js
pnpm --filter @whm/quoter start   # node dist/index.js
```

## Docker

```bash
pnpm --filter @whm/quoter build   # build dist first (Dockerfile copies it)
pnpm --filter @whm/quoter docker:build
pnpm --filter @whm/quoter docker:up    # docker stack deploy -c docker-compose.yml whm
```

> `polkadot-api` + `@galacticcouncil/sdk-next` are ESM/WASM, so the CJS esbuild bundle may need tweaks.
