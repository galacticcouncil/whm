# CLAUDE.md — WHM (Wormhole Messaging) Monorepo

## Protocol context

For Hydration protocol-level context (architecture, products, tokenomics, Omnipool mechanics), fetch the central context index via WebFetch:
`https://raw.githubusercontent.com/galacticcouncil/hydration/main/CLAUDE.md`

It lists available reference documents and their raw GitHub URLs.

## Project overview

Cross-chain messaging infrastructure connecting EVM chains, Solana, and Hydration via Moonbeam. Three concerns:

1. **On-chain contracts** — upgradeable Solidity (Foundry) on Base/Moonbeam/Hydration/Ethereum + an Anchor program on Solana.
2. **Off-chain agents** — long-running TS services that publish/index/relay (`broadcaster`, `bjscan`, `mrelayer`).
3. **Shared tooling** — a crash-safe migration runner, shared chain/wallet/args utilities, and the `migrations/` top-level orchestration.

**Repo:** `galacticcouncil/whm`
**Toolchain:** TypeScript 5.7 (strict, ES2022), Node 23.x. Solidity via Foundry + Soldeer. Rust via Cargo + Anchor 0.32.
**Package manager:** pnpm 10 (workspaces; see [pnpm-workspace.yaml](pnpm-workspace.yaml)).

### Use cases

- **Oracle Relay** — Solana program reads Kamino Scope prices + SPL stake-pool rates, broadcasts via Wormhole to Moonbeam, which forwards to Hydration's on-chain oracle via XCM. Ethereum-source variant reads wstETH / apyUSD rates directly. See [docs/oracle/spec.md](docs/oracle/spec.md), [docs/oracle/schema.md](docs/oracle/schema.md).
- **Basejump** — Instant cross-chain token bridging between EVM chains and Hydration via Moonbeam. Fast-path settles in ~2 min against a pre-funded landing pool; slow Wormhole TokenBridge transfer replenishes (~13 min). See [docs/basejump/spec.md](docs/basejump/spec.md), [docs/basejump/schema.md](docs/basejump/schema.md).
- **Intents** — Hydration users get any NEAR-Intents-supported asset (BTC, ZEC, NEAR, …) via OneClick quotes. One Hydration extrinsic (`IntentEmitter.swapAndBridge`) swaps the user's asset → WETH and bridges it via Moonbeam + Wormhole (TokenBridge slow replenish + fast VAA); `IntentRouter` forwards native ETH into the quote's `depositAddress` on Ethereum, atomic with the fast-path delivery. See [docs/intents/spec.md](docs/intents/spec.md), [docs/intents/fee.md](docs/intents/fee.md).

## Build & test

```sh
pnpm install                              # all workspace deps
```

Per-package scripts (invoked via pnpm filter or `cd <pkg>` + `pnpm <script>`):

```sh
# Solidity (Foundry)
pnpm --filter @whm/contracts install      # forge soldeer install
pnpm --filter @whm/contracts build        # forge build
pnpm --filter @whm/contracts test         # forge test

# Solana (Anchor + Cargo)
pnpm --filter @whm/crates-solana build    # anchor build -p oracle-emitter
pnpm --filter @whm/crates-solana test     # cargo test -p oracle-emitter
pnpm --filter @whm/crates-solana logs:local

# Agents (esbuild)
cd agents/<broadcaster|bjscan>
pnpm dev                                  # watch mode
pnpm build                                # dist/index.js
pnpm start
```

### Local forks (anvil)

```sh
pnpm fork:base          # :8546
pnpm fork:moonbeam      # :8545
pnpm fork:hydration     # :8547
pnpm fork:ethereum      # :8550
pnpm fork:all           # parallel
```

### Migrations

```sh
pnpm migrate:basejump-base:fork
pnpm migrate:basejump-base                   # prod
pnpm migrate:oracle-relay-solana:fork
pnpm migrate:oracle-relay-solana             # prod
pnpm migrate:oracle-relay-ethereum:fork
pnpm migrate:oracle-relay-ethereum           # prod
```

Full migration model + conventions: [migrations/README.md](migrations/README.md).

## Project structure

```
agents/
  broadcaster/            # @whm/broadcaster — Solana → Wormhole price/rate publisher
  bjscan/                 # @whm/bjscan — Basejump indexer
  mrelayer/               # standalone npm project (NOT a workspace member)

common/                   # @whm/common — shared TS (evm, args, migration)

contracts/                # @whm/contracts — Foundry / Solidity
  src/                    # contracts, grouped by feature (basejump/ oracles/ intents/ utils/)
  test/                   # tests, mirroring src/ layout
  scripts/                # per-feature TS ops scripts
  sh/                     # source-verification helpers

crates/                   # Rust umbrella (each subdir = its own Cargo workspace)
  solana/                 # @whm/crates-solana — Anchor workspace
    programs/             # Anchor programs (currently: oracle-emitter)
    scripts/              # Solana ops helpers

migrations/               # Cross-platform deployment runner
  run.ts                  # CLI entry
  README.md               # detailed model + conventions
  definitions/            # one merged migration per deployable feature
  actions/                # shared atomic operations
  envs/<context>/         # per-context multi-chain env files (prod/fork)

deployments/              # migration state files (write-once audit records)

docs/                     # protocol docs (basejump, oracle, intents,...)

sh/                       # cross-cutting bash wrappers (fork-*, migrate-*, verify-*)
```

### Workspace members

Declared in [pnpm-workspace.yaml](pnpm-workspace.yaml):

```
common
contracts
crates/solana
agents/broadcaster
agents/bjscan
```

`agents/mrelayer` is intentionally **not** a pnpm workspace member — it pre-dates the workspace setup and ships its own `package-lock.json`. Treat it as a standalone npm project.

### Dependency graph

```
Level 0 (no internal deps):  common
Level 1:                      contracts        → @whm/common (workspace:*)
                              crates/solana    → (Rust only, no TS workspace deps; common is used by migrations/scripts indirectly)
Level 2:                      agents/broadcaster → @whm/common; consumes Solana IDL via sync-idl
                              agents/bjscan      → @whm/common; consumes EVM/Hydration ABIs at runtime
                              migrations/        → @whm/common (top-level orchestration; not a workspace pkg itself)
```

Cross-platform glue lives at the **migration** layer and the **IDL/ABI sync** layer — agents don't import platform source directly.

## Key patterns

- **Merged migrations.** Each deployable feature lives in a single migration folder under `migrations/definitions/<name>/`. Step files are linear `NNN-<verb>-<subject>[@<contract>].ts`, ordered: deploys → authorize → wire → config → ownership-transfer/renounce. Multi-chain migrations (basejump-base touches Hydration + Moonbeam + Base) declare a `WalletContext` map; each step picks its wallet (`ctx.wallet.moonbeam`, `ctx.wallet.base`, etc.).
- **Env-driven dependencies (no `ctx.ref`).** If migration B needs an address from A's deployment, the operator copies it from `deployments/<env>/A.json` into `envs/<env>/B.env` as a config variable. B's step reads it as `ctx.env.SOME_ADDRESS`. State files are write-once audit records; never queried at runtime by other migrations.
- **PKs from env, not CLI.** Each migration declares `pks: ["PK_X", "PK_Y", …]` in its `index.ts`. Runner validates `process.env` has them before invoking `setup()`. `--pk` is NOT a flag.
- **Env contexts, not chain envs.** Env files are keyed by deployment context (`prod`, `fork`) — not by chain. A single `prod/basejump-base.env` holds all chain configs (RPC_BASE, RPC_MOONBEAM, RPC_HYDRATION). Variables are chain-prefixed where applicable.
- **State paths**: `deployments/<context>/<migration>.json`. One file per (env-context, migration) pair.
- **Renounced ownership is the prod end-state.** Every prod-ready migration ends in `transfer-ownership@*` (to a real custodian) or `renounce@*` (to `0x0`). After the migration completes, the state file is the immutable audit record.
- **Crash-safe.** State is persisted after each step. Resume by re-running the same command; reset a stage with `--from <step-name>`; pause early with `--pause-at <step-name>`.
- **Upgradeable contracts.** Solidity inherits OZ UUPS upgradeable patterns. Initialization is done in migration steps, not constructors.
- **Wormhole SDKs.** EVM uses `wormhole-solidity-sdk` (pinned via Soldeer). Solana uses Wormhole Core Bridge through Anchor. `mrelayer` agent uses `@wormhole-foundation/relayer-engine`.
- **Agent bundling.** `broadcaster` and `bjscan` bundle to a single `dist/index.js` via esbuild (CJS, node platform; see [esbuild.config.mjs](esbuild.config.mjs)). Avoid top-level await / ESM-only constructs in their `src/`.
- **IDL sync.** `broadcaster` consumes the Solana program's IDL — `pnpm run sync-idl` in `agents/broadcaster/` copies `crates/solana/target/idl/oracle_emitter.json` and `crates/solana/target/types/oracle_emitter.ts` into `agents/broadcaster/src/emitter/`. Re-run after Solana program changes.
- **Ops scripts.** `contracts/scripts/<feature>/` (EVM) and `crates/solana/scripts/<program>/` (Solana) hold one-shot `tsx`/`bash` entry points. They use the per-package `package.json` plus root `.env` for PKs.

## Testing guidelines

- **Solidity:** `pnpm --filter @whm/contracts test` (Foundry). Tests live in `contracts/test/` organized by feature subdir (`basejump/`, `oracles/`, `intents/`) + `mocks/`, `helpers/`, `integration/`, `utils/`.
- **Solana:** `pnpm --filter @whm/crates-solana test` (cargo test, no validator needed). For integration tests via `ts-mocha`, start a local validator first.
- **Agents:** No formal test suite. Validate via `pnpm dev` against a local fork/validator.
- **Migrations:** Run against `--env fork` first. The runner is idempotent — re-run picks up where it failed.

## Naming conventions

### Step file naming (inside `migrations/definitions/<migration>/`)

```
NNN-<verb>-<subject>[@<contract>].ts
```

Phases group naturally by NNN order:

1. **Deploys** — `001-deploy-<contract>.ts`. No `@` suffix.
2. **Authorize** — `NNN-authorize-<subject>@<contract>.ts`. Granting permissions.
3. **Wire** (cross-contract addresses) — `NNN-set-<thing>@<contract>.ts`. Storing one contract's address on another.
4. **Config** (per-asset / per-feature) — `NNN-set-<asset>-<thing>@<contract>.ts` or `NNN-register-<thing>@<contract>.ts`.
5. **Ownership** — `NNN-transfer-ownership@<contract>.ts` (to a custodian) or `NNN-renounce@<contract>.ts` (to `0x0`). Always last.

### Env var naming (inside `migrations/envs/<context>/<migration>.env`)

- Chain-prefixed: `RPC_<CHAIN>`, `CHAIN_ID_<CHAIN>`, `WORMHOLE_CORE_<CHAIN>`, `TOKEN_BRIDGE_<CHAIN>`, `WORMHOLE_ID_<CHAIN>`.
- Single-chain (Moonbeam-only XcmTransactor): unprefixed (`DESTINATION_PARA_ID`, `FEE_ASSET`, etc.).
- Asset-prefixed: `<ASSET>_<thing>` (e.g. `EURC_FEE_ASSET`, `PRIME_ASSET_ID_BYTES32`).
- Ownership: `<contract>_NEW_OWNER`.
- **PKs**: NOT in env files; live in shell env or root `.env`.

### Wallet keys (inside migration `WalletContext`)

Keys are chain names: `hydration`, `moonbeam`, `base`, `ethereum`, `solana`. Step files use `ctx.wallet.<chain>`.

## Commit & PR conventions

`scope: description` — lowercase, imperative, no period:

```
oracle: revoke ownership (immutable)
basejump: verify scripts
bjscan: onIngest hook
contracts: rename BasejumpBase to BasejumpCore
migrations: merge basejump-base
```

Common scopes: `oracle`, `basejump`, `intents`, `bjscan`, `contracts`, `crates`, `migrations`, `broadcaster`. Omit scope for repo-wide or generic changes.

## Dependencies

| Concern             | Tool                                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------------------- |
| Package manager     | pnpm 10 (workspaces)                                                                                    |
| Language (TS)       | TypeScript 5.7 (strict, ES2022 target)                                                                  |
| Language (Solidity) | Solidity via Foundry (`forge`, `anvil`)                                                                 |
| Language (Rust)     | Cargo + Anchor 0.32                                                                                     |
| TS bundler          | esbuild (CJS, node platform — for agents)                                                               |
| TS runner           | `tsx` for scripts; runner is `@whm/common/migration`                                                    |
| EVM deps            | Soldeer (forge-std, OZ upgradeable, wormhole-solidity-sdk)                                              |
| Wormhole            | `wormhole-solidity-sdk`, `@coral-xyz/anchor` (Solana), `@wormhole-foundation/relayer-engine` (mrelayer) |
| Polkadot interop    | `polkadot-api` (papi), `@galacticcouncil/descriptors`, `@galacticcouncil/common`                        |
| Web/API             | Fastify + `@fastify/cors` (bjscan)                                                                      |
| Database            | Postgres via `pg` (bjscan)                                                                              |
| Logging             | winston                                                                                                 |

## CI & deployment

- **Docker images** — `broadcaster` and `bjscan` ship as multi-arch images via `pnpm run docker:deploy` (uses `docker buildx`). Deploy with `docker stack deploy -c docker-compose.yml whm`.
- **No GitHub Actions workflow** is checked in — releases are manual.

## Key files

| File                                                     | Purpose                                             |
| -------------------------------------------------------- | --------------------------------------------------- |
| [pnpm-workspace.yaml](pnpm-workspace.yaml)               | Workspace member list                               |
| [tsconfig.json](tsconfig.json)                           | Root TS config (strict, ES2022, bundler resolution) |
| [esbuild.config.mjs](esbuild.config.mjs)                 | Shared agent bundler config                         |
| [common/migration/runner.ts](common/migration/runner.ts) | Crash-safe migration runner core                    |
| [common/migration/run.ts](common/migration/run.ts)       | Migration CLI entry                                 |
| [common/utils/args.ts](common/utils/args.ts)             | Shared CLI args parser                              |
| [contracts/foundry.toml](contracts/foundry.toml)         | Foundry / Soldeer config                            |
| [crates/solana/Anchor.toml](crates/solana/Anchor.toml)   | Anchor config (program id, validator settings)      |
| [crates/solana/Cargo.toml](crates/solana/Cargo.toml)     | Solana workspace                                    |
| [migrations/README.md](migrations/README.md)             | Migration model + conventions                       |

## AI agent guidance

### Before editing any file

1. **Identify the package** the file belongs to and read its `package.json` for scripts and deps.
2. **Check `pnpm-workspace.yaml`** — `mrelayer` is intentionally NOT a workspace member.
3. **For TS:** check the root `tsconfig.json`; per-package `tsconfig.json` extends it.
4. **For contracts:** check `contracts/foundry.toml` and `contracts/remappings.txt` before adding imports.
5. **For the Solana program:** check `crates/solana/Anchor.toml`, `crates/solana/Cargo.toml`, and existing accounts under `crates/solana/programs/oracle-emitter/src/`.
6. **For migrations:** read [migrations/README.md](migrations/README.md) before adding a step or migration.

### Tracing code across the repo

- **Oracle path (Solana source):** Solana `oracle-emitter` (Anchor) → Wormhole Core Bridge (VAA) → `mrelayer` → `OracleDispatcher` on Moonbeam (extends `MessageReceiver`) → `XcmTransactor` → Hydration oracle pallet.
- **Oracle path (Ethereum source):** `OracleEmitter` on Ethereum → Wormhole → (parallel) `OracleDispatcher` proxy on Moonbeam → `XcmTransactor` → Hydration. Each source chain has its OWN dispatcher + transactor proxy pair (renounced ownership = no shared infra).
- **Basejump path:** Source EVM `Basejump.sol` → Wormhole → `BasejumpProxy.sol` (Moonbeam) → `XcmTransactor` → `BasejumpLanding.sol` (Hydration). Fast-path is a separate signed VAA flow handled by `Basejump.completeTransfer`.
- **Intents path:** `IntentEmitter.sol` (Hydration) swaps the user's asset → WETH, then via XCM `batch_all` (reserve-transfer WETH+GLMR to its Moonbeam MDA + Transact-as-MDA) calls `BasejumpProxy.bridgeViaWormhole` → Wormhole TokenBridge (slow pool replenish) + fast VAA → Ethereum `Basejump` → `BasejumpLandingNative` (remaps source WETH → native ETH via `destAssetFor`) → `IntentRouter.sol` (`IBasejumpReceiver`) → OneClick quote `depositAddress` (native ETH).
- **Off-chain:** `broadcaster` reads Solana oracle state and signs `send_price` / `send_rate` instructions. `bjscan` indexes Basejump events from Moonbeam/Base/Hydration and exposes them via Fastify. `mrelayer` polls Wormhole for VAAs and submits them to receiver contracts.
- **Shared:** `@whm/common` exports `chains`, `ifs`, `wallet`, `args`, `migration`. Any change here affects all consumers.

### Validating changes

1. **Solidity:** `pnpm --filter @whm/contracts build && pnpm --filter @whm/contracts test`. For migration changes, run against `--env fork` end-to-end via `pnpm migrate:<name>:fork`.
2. **Solana:** `pnpm --filter @whm/crates-solana build && pnpm --filter @whm/crates-solana test`. For TS-mocha integration tests against a local validator, start it first.
3. **Agents:** `cd agents/<pkg> && pnpm build` then `pnpm dev` against a local fork/validator.
4. **After Solana program changes that touch IDL:** `cd agents/broadcaster && pnpm sync-idl` to refresh `src/emitter/idl.json` and `src/emitter/types.ts`.

### What NOT to break

- **Do not edit prod state files under `deployments/prod/`** — they're the audit record of renounced/immutable deployments. Reconstruct manually from chain state if absolutely needed.
- **Do not skip migration step ordering** — `NNN-*.ts` numbering is load-bearing. To insert a step, renumber carefully; `--from` re-runs from a step onward.
- **Do not bypass the migration runner** with ad-hoc deploy scripts — the runner is the single source of truth for crash safety, resume, and audit.
- **Keep contracts upgradeable-safe** — they inherit OZ UUPS upgradeable; never add state-init constructors; respect storage layout when adding fields.
- **Do not commit `.env`** (gitignored). `.env.<context>` templates are checked in (no secrets, just RPCs).
- **Do not modify `agents/mrelayer` as a workspace package** — it has its own `package-lock.json`. Run `npm install` inside it, not pnpm.
- **`broadcaster` and `bjscan` bundle to CJS** via esbuild — avoid top-level await or ESM-only constructs in `src/`.
- **Sync IDL/types before merging Solana program changes** — `broadcaster` will silently break against outdated types.
- **Don't add `ctx.ref` cross-migration calls** — that pattern was removed. Cross-deployment dependencies go through env-config copies.
