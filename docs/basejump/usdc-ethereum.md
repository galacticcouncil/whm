# Basejump — USDC from Ethereum

Add USDC as a Basejump asset, sourced from Ethereum mainnet via Wormhole.

## Scope

- **Asset:** USDC (6dp). USDT / further stables later.
- **Transport:** Wormhole TokenBridge + fast-path VAA (no Snowbridge / snowfork dependency).
- **Source chain:** Ethereum mainnet.
- **Hydration landing:** reuse the existing `basejump-base` landing (`0x70e9…df976`) — it is
  multi-asset, so it serves USDC alongside EURC.
- **Environment:** fork e2e validated; prod source-side stack (Ethereum + Moonbeam) deployed & wired — go-live pending (landing route, `usdc_mwh` pool, ownership handoff, relayer).

## Architecture

```
Ethereum                         Moonbeam (new proxy+transactor)     Hydration (existing landing)
Basejump (USDC)  ── Wormhole ──▶ BasejumpProxy ── XcmTransactor ──▶ BasejumpLanding (basejump-base)
  • TokenBridge slow (~13min, MRL → landingDest)                     delivers USDC.mwh from
  • publishMessage finality=200 (fast VAA, ~secs)                    pre-funded pool, queues if short
```

## Migration — `migrations/definitions/basejump-ethereum/`

Deploys a fresh source-side stack on **Ethereum + Moonbeam** only and wires it to the existing
`basejump-base` Hydration landing. The base proxy/landing have renounced ownership and the base
`Basejump` is Base-only, so Ethereum needs its own `Basejump` + proxy + transactor — but the landing,
being multi-asset, is shared. 12 runner steps:

- **`types.ts`** — `WalletContext { moonbeam, ethereum }`.
- **`index.ts`** — `name: "basejump-ethereum"`, `pks: ["PK_PROXY", "PK"]`.
- **Tooling** — `sh/migrate-basejump-ethereum.sh` + `migrate:basejump-ethereum[:fork]` scripts.

| #   | Step                          | Notes                                                    |
| --- | ----------------------------- | -------------------------------------------------------- |
| 001 | `deploy-basejump`             | Ethereum                                                 |
| 002 | `deploy-proxy`                | Moonbeam                                                 |
| 003 | `deploy-transactor`           | Moonbeam (its `mdaH160` is the bridge the TC authorizes) |
| 004 | `authorize-proxy@transactor`  | Moonbeam                                                 |
| 005 | `set-transactor@proxy`        | Moonbeam                                                 |
| 006 | `set-emitter@proxy`           | `emitterChain = WORMHOLE_ID_ETHEREUM (2)`                |
| 007 | `set-landing@proxy`           | landing = `HYDRATION_LANDING` (existing base landing)    |
| 008 | `set-emitter@basejump`        | `emitterChain = WORMHOLE_ID_MOONBEAM (16)`               |
| 009 | `set-landing-dest@basejump`   | landingDest = `HYDRATION_LANDING`                        |
| 010 | `set-usdc-fee@basejump`       | `USDC_FEE_ASSET` / `USDC_FEE_AMOUNT`                     |
| 011 | `transfer-ownership@proxy`    | `PROXY_NEW_OWNER` (proxy + transactor)                   |
| 012 | `transfer-ownership@basejump` | `BASEJUMP_NEW_OWNER` (Ethereum custodian)                |

No `deploy-landing` / `transfer-ownership@landing` — the landing already exists and is TC-owned.

## Governance handoff — Hydration landing

The reused landing (`0x70e9…df976`) is owned by the Hydration TC (`0xaa7e…`); the two calls this
corridor needs on it are `onlyOwner`, so they are **not** part of the migration — the TC applies them
after deploy:

1. `setAuthorizedBridge(<step-003 mdaH160>, true)` — authorize the new XcmTransactor's MDA.
2. `setDestAsset(USDC_SOURCE_ASSET, USDC_DEST_ASSET)` — map Ethereum USDC → `usdc_mwh` (currency 21).

Use `contracts/scripts/basejump-landing/addRoute.ts` to build these — it reads current state and prints
the owner calldata for governance (`--send` submits directly when you hold the owner key, e.g. on a fork).

The landing must also hold a pre-funded `usdc_mwh` pool before go-live.

## Relayer

The fast-path VAA (Ethereum `Basejump` emitter → Moonbeam `BasejumpProxy.completeTransfer`) is carried by
`mrelayer`'s default app (`agents/mrelayer/src/app.ts`): a `basejumpEthApp` watcher mirroring the Base one
(`CHAIN_ID_ETH` → the corridor's Proxy, task type `'insta-eth'`). The slow TokenBridge/MRL leg is already
covered by the same app's `mrlApp` (it watches `CHAIN_ID_ETH`). Set the start sequence via `BASEJUMP_ETH_FROM_SEQ`.

## Env — `migrations/envs/{fork,prod}/basejump-ethereum.env`

Moonbeam / XcmTransactor blocks identical to `basejump-base`. Ethereum + reused landing + USDC:

```sh
# Ethereum (fork RPC: http://127.0.0.1:8550)
CHAIN_ID_ETHEREUM=1
WORMHOLE_ID_ETHEREUM=2
WORMHOLE_CORE_ETHEREUM=0x98f3c9e6E3fAce36bAAd05FE09d375Ef1464288B   # verified live
TOKEN_BRIDGE_ETHEREUM=0x3ee18B2214AFF97000D974cf647E7C347E8fa585    # verified live (chainId()==2)

# Reused basejump-base Hydration landing (proxy + basejump point here)
HYDRATION_LANDING=0x70e9b12c3b19cb5f0e59984a5866278ab69df976

# USDC fee (runner: set on Basejump)
USDC_FEE_ASSET=0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48
USDC_FEE_AMOUNT=100000                                             # 0.1 USDC — resize for ETH gas

# Governance handoff (TC, not run by the migration)
USDC_SOURCE_ASSET=0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48        # USDC on Ethereum, 6dp
USDC_DEST_ASSET=0x0000000000000000000000000000000100000015         # USDC.mwh = Hydration currency 21

# Ownership renunciation
PROXY_NEW_OWNER=0xb041705871c4c5537a1a57edd4d62f66217522a7         # Moonbeam MDA
BASEJUMP_NEW_OWNER=<ethereum-custodian>                            # TBD (prod)
```

Fork sets a placeholder `BASEJUMP_NEW_OWNER` so all 12 steps complete; prod leaves it unset until a
real custodian exists (step 012 fails fast otherwise).

## Testing

1. **Foundry integration** — `contracts/test/integration/BasejumpEthereumIntegrationTest.sol` (mock
   Wormhole / TokenBridge / XCM precompile, chain id 2): happy path + fee + queue/fulfill + replay +
   unauthorized-emitter. `pnpm --filter @whm/contracts test`. (Deploys its own mock landing, so it is
   unaffected by the reuse decision.)
2. **Fork migration** — `pnpm fork:ethereum && fork:moonbeam && fork:hydration`, then
   `pnpm migrate:basejump-ethereum:fork`. Deploys + wires + renounces the Eth/Moonbeam stack against
   the forked landing. The two TC governance calls are **not** applied by the migration — apply them with
   `contracts/scripts/basejump-landing/addRoute.ts` (`--send`, impersonating the landing owner on the fork).
   The fast-path relay is carried by `mrelayer` (its default app now includes the Ethereum corridor).

Post-run checks: `quoteFee(USDC) == USDC_FEE_AMOUNT` on the Ethereum Basejump; the proxy's `landings(2)`
and the Basejump's `landingDest` both equal `HYDRATION_LANDING`.

## bjscan

Handlers are asset-agnostic (decode raw `asset` / `sourceAsset`). Topology change for a second corridor:

- **config.ts** — `source` → list (Base + Ethereum). New env: `ETHEREUM_RPC_URL`,
  `ETHEREUM_START_BLOCK`, `ETHEREUM_CONTRACT`.
- **index.ts** — one `EvmWatcher` per source.
- **Matching** — both corridors now land on the **same** Hydration landing, so the landing address no
  longer identifies the corridor; `findInitiated` must disambiguate on **source asset / source chain**
  (Ethereum USDC vs Base EURC). Enable the Ethereum source before it goes live (the shared `hydration`
  cursor does not revisit old blocks).
