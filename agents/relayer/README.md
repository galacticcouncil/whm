# relayer

Wormhole VAA relayer. Watches guardian-signed VAAs over a Spy stream and submits them to the
contract that consumes them, with Redis-backed retries and missed-VAA recovery from
[`@wormhole-foundation/relayer-engine`](https://github.com/wormhole-foundation/relayer-engine).

## Apps

One app per process, one process per container. Each is its own entry point —
`dist/<app>/app.js` — so nothing is selected at runtime and there is no way to end up running the
wrong one. Each keeps its own engine app and its own Redis namespace.

### `ntt`

Redeems NTT transfers **into Hydration** from Ethereum, Base, Solana, and Sui. Watches the eleven
deployed origin transceivers ([routes.ts](src/apps/ntt/routes.ts)) and submits each transfer VAA to
that route's Hydration transceiver.

### `oracle`

Relays oracle price and rate VAAs **into Hydration**. Each source chain has its own OracleReceiver
deployment ([routes.ts](src/apps/oracle/routes.ts)); a VAA goes to the receiver for its source, which
verifies the emitter and writes the price in one call.

### `intent`

Relays intents **from Hydration to Ethereum**. Hydration settles WETH over NTT and publishes a
forwarding instruction beside it; this pairs the two and calls
`IntentReceiver.processOrder(nttVaa, instructionVaa, feeRequested)`, which delivers the settlement,
forwards it to the order's `depositAddress`, and reimburses the caller. The fee is measured, not
forecast — `estimateContractGas` on the real call at the order's own ceiling, priced at
`maxFeePerGas` — and is retried with backoff while it exceeds the order's `maxRelayFee`.

Only the settlement is subscribed to — the instruction is derived from the source transaction on
demand, so there is no pairing state to lose across restarts.

Its three addresses live in [routes.ts](src/apps/intent/routes.ts); the app validates them at
startup and refuses to run on a blank or malformed one.

### `basejump`

Relays Basejump fast-path VAAs **into Hydration**. A source `BasejumpEmitter` publishes a net payout
instruction beside each NTT settlement; this submits it to that corridor's `BasejumpReceiver`
([routes.ts](src/apps/basejump/routes.ts)), which verifies the emitter and pays the recipient out of
the shared landing pool in one call. The settlement leg is the `ntt` app's — this one only carries
the payout.

A landing revert unwinds the VAA, so a retry is always safe; a pool shortfall queues instead of
reverting, so the only failures are transient and the retry budget is sized in hours. Latency is the
point, so it does not wait on Wormholescan for the source tx hash.

## Configuration

Env holds only what changes between deployments. Routes, addresses, retry policy, backoff and age
caps are constants in each app's `config.ts` and `routes.ts`.

| Variable              | Description                                       | Default                               |
| --------------------- | ------------------------------------------------- | ------------------------------------- |
| `PRIVKEY`             | Signing key. Same name everywhere — **see below** | Required                              |
| `RPC_HYDRATION`       | Hydration EVM RPC (chain `222222`)                | `https://hydration-rpc.n.dwellir.com` |
| `RPC_ETHEREUM`        | Ethereum RPC (`intent` only)                      | `https://eth.llamarpc.com`            |
| `SPY_ENDPOINT`        | Wormhole Spy endpoint                             | `localhost:7073`                      |
| `REDIS_HOST`          | Redis host                                        | `localhost`                           |
| `REDIS_PORT`          | Redis port                                        | `6379`                                |
| `WORMHOLE_API_KEY`    | Wormholescan API key (raises rate limit)          | optional                              |
| `DISCORD_WEBHOOK_URL` | Low-gas / out-of-gas alerts                       | optional                              |
| `GAS_WARN_MULTIPLIER` | Warn below this multiple of one submission's cost | `50`                                  |
| `FROM_SEQ_<CHAIN>`    | Cold-start floor per chain — **see below**        | `0`                                   |
| `LOG_LEVEL`           | winston level                                     | `info`                                |
| `APP_NAME`            | Engine namespace override — **see below**         | per-app                               |

`PRIVKEY` is one name across every app, and the services still hold **different keys** — that is what
keeps the NTT, oracle, intent and basejump wallets off each other's nonce.

## Development

```bash
pnpm install
pnpm --filter @whm/relayer dev oracle   # esbuild watch + run one app (reads .env)
pnpm --filter @whm/relayer redis        # local Redis
pnpm --filter @whm/relayer mainnet-spy
```

## Production

```bash
pnpm --filter @whm/relayer build        # → dist/{ntt,oracle,intent,basejump}/app.js
pnpm --filter @whm/relayer start:oracle
pnpm --filter @whm/relayer docker:up
```

One image; the swarm service names the entry point:

```yaml
app-oracle:
  image: galacticcouncil/relayer:latest
  command: [node, oracle/app.js]
```

## Notes

### The engine namespace is load-bearing

Every Redis key the engine writes derives from the app's `name`:

```
queue          {name}:{name}-relays
seen VAAs      {name}:missedVaasV3:seenVaas:{chain}:{emitter}
failed fetch   {name}:missedVaasV3:failedToFetch:{chain}:{emitter}
safe sequence  {name}:missedVaasV3:safeSequence:{chain}:{emitter}
```

Renaming orphans that state. The missed-VAA worker then falls back to the `FROM_SEQUENCE` floors and
rescans — replaying a backlog, or silently skipping everything before the floor. Each app's
`config.ts` carries the name already in Redis (`hydration-ntt-relayer`, `oracle-relayer`,
`intent-relayer`, `basejump-relayer`); `APP_NAME` overrides it, which is only for running a second deployment beside the
live one. Do not rename to tidy up.

The `FROM_SEQUENCE` floors only matter on a cold start. Once a `safeSequence` exists the engine reads
from there, which is why they can sit at `0`. Each entry defaults from `FROM_SEQ_<CHAIN>`
(`FROM_SEQ_HYDRATION`, `FROM_SEQ_SOLANA`, …), so a floor can be set at deploy time — but only before
a namespace's first run, since nothing reads it afterwards.

Set one when an app subscribes to an emitter that was already busy before the app existed. Otherwise
the missed-VAA worker walks the whole history, and on chain 73 that walk does not even terminate: the
guardian gRPC returns `code 13` rather than `code 5` for old Hydration sequences, so
`tryFetchVaa` throws instead of returning null, the sequences land in `failedToFetch`, and
`calculateLastSafeSequence` pins `safeSequence` to `failedToFetch[0] - 1` on every 30s cycle
forever. Wormholescan's REST API serves those same VAAs fine — it is only the engine's internal gRPC
path, which has no fallback, that fails.

### Retry budget vs age cap

Throwing from a handler is the engine's retry mechanism, not a crash: BullMQ fails that one job and
reschedules it with backoff. But it is bounded — after `retries` attempts the job lands in the failed
set for good. The intent app's backoff budget (~2h) deliberately exceeds its age cap (1h), so an
unprofitable order exits via the logged "stale" path rather than accumulating in `failed`. Raising
`MAX_VAA_AGE_MS` above the retry window would break that.

### Chain 73 and the engine's SDK

relayer-engine depends on `@certusone/wormhole-sdk`, which predates Hydration and has no chain 73.
`app.chain(73).address(…)` therefore throws `Unrecognized wormhole chainId`. The engine layer
registers handlers under the pre-encoded emitter key instead
([engine/emitter.ts](src/engine/emitter.ts)) — for an EVM chain that encoding is only the address
left-padded to 32 bytes. Everything else degrades gracefully: the TokenBridge middleware skips it, no
provider is built for it, and only a missed-VAA metrics label reads `undefined`.

One consequence: the engine prefixes `0x` onto a `sourceTxHash` only for chains its SDK recognises as
EVM, so chain-73 hashes arrive bare and are normalised in [engine/vaa.ts](src/engine/vaa.ts).

### Why dependencies are not bundled

`@certusone/wormhole-sdk` pulls the Injective/Cosmos SDKs, which have circular CJS requires and
re-exported TS enums esbuild cannot flatten — the bundle builds and then dies at load with
`Cannot read properties of undefined (reading 'Mainnet')`. So `packages: "external"`, and the
Dockerfile installs them.

Related: those same packages ship a broken range. `@injectivelabs/networks` asks for
`ts-types@^1.10.12` and resolvers pick `1.20.12`, which dropped the enum it needs — so
relayer-engine cannot load at all. `ts-types` is pinned to `1.10.12` in both
[pnpm-workspace.yaml](../../pnpm-workspace.yaml) (pnpm, local) and this package's `overrides` (npm,
Docker). Both are needed; keep them in step.
