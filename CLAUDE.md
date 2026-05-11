# CLAUDE.md — WHM (Wormhole Messaging) Monorepo

## Protocol context

For Hydration protocol-level context (architecture, products, tokenomics, Omnipool mechanics), fetch the central context index via WebFetch:
`https://raw.githubusercontent.com/galacticcouncil/hydration/main/CLAUDE.md`

It lists available reference documents and their raw GitHub URLs.

## Project overview

Cross-chain messaging infrastructure built on Wormhole, connecting EVM chains, Solana, and Hydration via Moonbeam. Three concerns live in this repo:

1. **On-chain contracts** — upgradeable Solidity contracts on Moonbeam/EVM, and an Anchor program on Solana.
2. **Off-chain agents** — long-running TypeScript services that trigger broadcasts, scan transfers, and relay VAAs.
3. **Shared tooling** — a crash-safe migration runner and CLI args parsing used by both platforms.

**Repo:** `galacticcouncil/whm` (workspace name `@whm/core`)
**Toolchain:** TypeScript 5.7 (strict, ES2022), Node 23.x (`package.json#engines`)
**Package manager:** pnpm 10 (workspaces, see [pnpm-workspace.yaml](pnpm-workspace.yaml))

### Use cases

- **Oracle Relay** — Solana program reads Kamino Scope oracle prices and broadcasts them through Wormhole to Moonbeam, which forwards price updates to Hydration's on-chain oracle via XCM. See [docs/oracle/spec.md](docs/oracle/spec.md), [docs/oracle/schema.md](docs/oracle/schema.md).
- **Basejump** — Instant cross-chain token bridging between EVM chains and Hydration via Moonbeam. Fast-path settles in ~60s; slow Wormhole Token Bridge transfer settles in the background (~13 min). See [docs/basejump/spec.md](docs/basejump/spec.md), [docs/basejump/schema.md](docs/basejump/schema.md).

## Build & test

```sh
pnpm install                              # Install all workspace deps
```

Per-platform — run from the respective package directory:

```sh
# EVM contracts (Foundry)
cd platforms/evm
pnpm run install                          # forge soldeer install
pnpm run build                            # forge build
pnpm run test                             # forge test

# Solana program (Anchor)
cd platforms/solana
pnpm run build                            # anchor build -p message-emitter
pnpm run test                             # cargo test -p message-emitter

# Agents (Node services, esbuild)
cd agents/<broadcaster|bjscan>
pnpm run dev                              # watch mode (esbuild + node --watch)
pnpm run build                            # bundle to dist/index.js
pnpm start                                # node dist/index.js
```

### Local forks (EVM)

```sh
cd platforms/evm
pnpm run fork:base                        # http://127.0.0.1:8546
pnpm run fork:moonbeam                    # http://127.0.0.1:8545
pnpm run fork:hydration                   # http://127.0.0.1:8547
pnpm run fork:all                         # all three in parallel
```

### Local validator (Solana)

```sh
cd platforms/solana
pnpm run validator                        # local solana-test-validator
pnpm run test:validator                   # tests against the validator
```

## Code style

- **TypeScript:** strict mode, `module: es2022`, `moduleResolution: bundler`, `target: es2022`. Root [tsconfig.json](tsconfig.json) is extended by each package.
- **Modules:** ESM (`"type": "module"`) for `common`, EVM, Solana packages. Agents bundle to CJS via esbuild.
- **Solidity:** Foundry/forge with Soldeer dependencies. Style follows the OpenZeppelin upgradeable contracts conventions already in use.
- **Rust:** Standard Cargo formatting. Release profile is overflow-checked with full LTO ([platforms/solana/Cargo.toml](platforms/solana/Cargo.toml)).

## Commit & PR conventions

Commit messages use `scope: description` format — lowercase, imperative, no period:

```
oracles: revoke ownership (immutable)
oracle: verify scripts
bjscan: onIngest hook
subscan verification
basejump contract verification script
```

Common scopes: `oracle`, `oracles`, `basejump`, `bjscan`, `evm`, `broadcaster`. Omit scope for repo-wide or generic changes.

## Project structure

```
common/                            # @whm/common — shared TS utilities (workspace pkg)
  utils/                           # args parsing
  migration/                       # crash-safe deployment runner (runner.ts, run.ts)
platforms/
  evm/                             # @whm/platform-evm — Solidity + Foundry + TS scripts
    contracts/                     # Foundry project (forge soldeer install)
      src/                         # Basejump*.sol, MessageDispatcher.sol, XcmTransactor.sol, …
      test/                        # *.t.sol unit & integration
    migrations/                    # definitions/, actions/, envs/, run.ts
    scripts/                       # standalone ops scripts (tsx)
    sh/                            # bash wrappers (fork-*.sh, migrate-*.sh)
    deployments/                   # per-env state files (gitignored data)
    verify-hydration/              # source verification helper
  solana/                          # @whm/platform-solana — Anchor program + TS scripts
    programs/message-emitter/      # Rust/Anchor program
    migrations/                    # definitions/, actions/, envs/, run.ts
    scripts/                       # standalone ops scripts (tsx)
    deployments/                   # per-env state files
agents/
  broadcaster/                     # @whm/broadcaster — Solana → Wormhole price broadcaster
  bjscan/                          # @whm/bjscan — Basejump indexer + REST/UI (Fastify + pg)
  mrelayer/                        # mrelayer — Wormhole relayer-engine (legacy npm, own lockfile)
docs/
  migration.md                     # migration runner usage
  oracle/                          # spec.md, schema.md
  basejump/                        # spec.md, schema.md, indexer.md
scripts/
  docker-multiarch.sh              # buildx helper for cross-arch images
esbuild.config.mjs                 # shared esbuild config (CJS, node platform)
pnpm-workspace.yaml                # workspace member list
```

### Workspace members

Declared in [pnpm-workspace.yaml](pnpm-workspace.yaml):

```
common
platforms/evm
platforms/solana
agents/broadcaster
agents/bjscan
agents/mrelayer
```

> `agents/mrelayer` is intentionally **not** a pnpm workspace member — it pre-dates the workspace setup and ships its own `package-lock.json`. Treat it as a standalone npm project.

### Dependency graph

```
Level 0 (no internal deps):  common
Level 1:                      platforms/evm     → @whm/common (workspace:*)
                              platforms/solana  → @whm/common (workspace:*)
Level 2:                      agents/broadcaster → consumes Solana IDL via sync-idl
                              agents/bjscan      → consumes EVM/Hydration ABIs at runtime
```

Cross-platform glue lives at the **migration** and **IDL/ABI sync** layer, not at the TypeScript module level — agents don't import platform source directly.

## Key patterns

- **Crash-safe migrations.** Both platforms use the same runner from `@whm/common/migration`. Each migration is a folder under `migrations/definitions/<name>/` with an `index.ts` (`setup` function) and numbered step files `NNN-*.ts`. State is persisted to `deployments/{env}/{migration}.json` after every step, and re-runs skip completed steps. Step outputs are passed via `ctx.outputs["step-name"].field`. See [docs/migration.md](docs/migration.md).
- **Env loading for migrations.** The runner loads `migrations/envs/{migration}.{env}.env`. Shell variables override file values. Common flags: `--migration`, `--env`, `--pk`, `--from` (reset & retry from step), `--pause-at` (pause after step).
- **Upgradeable contracts.** Solidity contracts inherit from OpenZeppelin's upgradeable contracts (`openzeppelin-contracts-upgradeable@5.5.0`). Initialization happens through migration steps, not constructors.
- **Wormhole SDKs.** EVM uses `wormhole-solidity-sdk` (pinned via Soldeer). Solana uses Wormhole Core Bridge accounts directly through Anchor. The `mrelayer` agent uses `@wormhole-foundation/relayer-engine` for VAA polling/relay.
- **Agent bundling.** `broadcaster` and `bjscan` bundle their entire dep tree to a single `dist/index.js` via esbuild (CJS, node platform — see [esbuild.config.mjs](esbuild.config.mjs)). Dev mode runs `node --watch` over the bundle. Docker images are multi-arch (`linux/amd64,linux/arm64`).
- **IDL sync.** `broadcaster` consumes the Solana message-emitter IDL — `pnpm run sync-idl` copies `target/idl/message_emitter.json` and `target/types/message_emitter.ts` from `platforms/solana/` into `agents/broadcaster/src/emitter/`. Re-run after rebuilding the Solana program.
- **Standalone ops scripts.** `scripts/*` directories under each platform are one-shot `tsx` entry points (e.g. `scripts/emitter/sendPrice.ts`). They use `DOTENV_CONFIG_PATH` to pick the right env file. Documented in each platform's README.

## Testing guidelines

- **EVM:** Foundry — `forge test` under [platforms/evm/contracts/](platforms/evm/contracts/). Tests are `*.t.sol` / `*Test.sol` under `contracts/test/`, including unit, integration, and mocks.
- **Solana:** Two layers — Rust unit tests via `cargo test -p message-emitter` (run in CI/dev without a validator), and TS integration tests via `ts-mocha` against a local validator (`anchor test` / `pnpm run test:validator`).
- **Agents:** No formal test suite at present. Validate via `pnpm run dev` against a local fork/validator.
- **Migrations:** Test by running against `--env fork` first — the runner is idempotent, so a partial run can be resumed or re-run from `--from <step>`.

## Dependencies

| Concern             | Tool                                                                             |
| ------------------- | -------------------------------------------------------------------------------- |
| Package manager     | pnpm 10 (workspaces)                                                             |
| Language (TS)       | TypeScript 5.7 (strict, ES2022 target)                                           |
| Language (Solidity) | Solidity via Foundry (`forge`, `anvil`)                                          |
| Language (Rust)     | Cargo + Anchor 0.32                                                              |
| TS bundler          | esbuild (CJS, node platform — for agents)                                        |
| TS runner           | `tsx` for scripts, `ts-node` for some legacy paths                               |
| EVM deps            | Soldeer (forge-std, OZ upgradeable, wormhole-sdk)                                |
| Wormhole            | `@certusone/wormhole-sdk`, `@wormhole-foundation/relayer-engine`                 |
| Polkadot interop    | `polkadot-api` (papi), `@galacticcouncil/descriptors`, `@galacticcouncil/common` |
| Web/API             | Fastify + `@fastify/cors` (bjscan)                                               |
| Database            | Postgres via `pg` (bjscan)                                                       |
| Logging             | winston                                                                          |

## CI & deployment

- **Docker images** — `broadcaster` and `bjscan` ship as multi-arch images via `pnpm run docker:deploy` (uses `docker buildx`). Deploy with `docker stack deploy -c docker-compose.yml whm`.
- **No formal GitHub Actions workflow** is checked in at the time of writing — releases are manual via the Docker scripts above.

## Key files

| File                                                                         | Purpose                                             |
| ---------------------------------------------------------------------------- | --------------------------------------------------- |
| [pnpm-workspace.yaml](pnpm-workspace.yaml)                                   | Workspace member list                               |
| [tsconfig.json](tsconfig.json)                                               | Root TS config (strict, ES2022, bundler resolution) |
| [esbuild.config.mjs](esbuild.config.mjs)                                     | Shared agent bundler config                         |
| [common/migration/runner.ts](common/migration/runner.ts)                     | Crash-safe migration runner core                    |
| [common/migration/run.ts](common/migration/run.ts)                           | Migration CLI entry                                 |
| [common/utils/args.ts](common/utils/args.ts)                                 | Shared CLI args parser                              |
| [platforms/evm/contracts/foundry.toml](platforms/evm/contracts/foundry.toml) | Foundry / Soldeer config                            |
| [platforms/solana/Anchor.toml](platforms/solana/Anchor.toml)                 | Anchor config (program id, validator settings)      |
| [platforms/solana/Cargo.toml](platforms/solana/Cargo.toml)                   | Solana workspace                                    |
| [docs/migration.md](docs/migration.md)                                       | Migration runner reference                          |

## AI agent guidance

### Before editing any file

1. **Identify the package** the file belongs to and read its `package.json` for scripts and deps.
2. **Check `pnpm-workspace.yaml`** to see whether it's a workspace member (mrelayer is not).
3. **For TS:** inspect the package's `tsconfig.json` — they all extend the root config but set their own `rootDir`/`outDir`.
4. **For contracts:** check `foundry.toml` and `remappings.txt` under [platforms/evm/contracts/](platforms/evm/contracts/) before adding imports.
5. **For the Solana program:** check `Cargo.toml`, `Anchor.toml`, and existing accounts under [platforms/solana/programs/message-emitter/src/](platforms/solana/programs/message-emitter/src/).

### Tracing code across the repo

- **Oracle path:** Solana `message-emitter` → Wormhole Core Bridge (VAA) → `mrelayer` (or guardian relay) → `MessageReceiver` / `MessageDispatcher` on Moonbeam → `XcmTransactor` → Hydration oracle pallet.
- **Basejump path:** Source EVM `Basejump.sol` → Wormhole → `BasejumpProxy.sol` (Moonbeam) → `BasejumpLanding.sol` (Hydration via XCM). Fast-path is a separate signed VAA flow handled by `Basejump.completeTransfer`.
- **Off-chain side:** `broadcaster` reads Solana oracle state and signs `sendPrice` / `sendRate` instructions on the emitter program. `bjscan` indexes Basejump events from Moonbeam/Base/Hydration and exposes them via Fastify.
- **Shared:** `@whm/common` exports `utils` (args parsing) and `migration` (runner). Any change here affects both platforms.

### Validating changes

1. **EVM:** `cd platforms/evm && pnpm run build && pnpm run test`. For migration changes, run against `--env fork` end-to-end.
2. **Solana:** `cd platforms/solana && pnpm run build && pnpm run test`. For integration changes, start `pnpm run validator` in one shell and run scripts against it.
3. **Agents:** `cd agents/<pkg> && pnpm run build` (sanity), then `pnpm run dev` against a local fork/validator. There are no unit tests — verify behavior end-to-end.
4. **After Solana program changes that touch IDL:** run `cd agents/broadcaster && pnpm run sync-idl` to refresh `src/emitter/idl.json` and `src/emitter/types.ts`.

### What NOT to break

- **Do not edit migration state files under `deployments/`** unless you understand the runner — they encode completed-step state and are the only thing preventing re-execution.
- **Do not skip migration step ordering** — `NNN-*.ts` numbering is load-bearing. If you need to insert a step, renumber carefully or use `--from` to re-run.
- **Do not bypass `@whm/common`'s migration runner** by writing ad-hoc deploy scripts — the runner is the single source of truth for crash safety and resumability.
- **Keep contracts upgradeable-safe** — they inherit from OZ upgradeable; do not add constructors with state initialization, and respect storage layout when adding fields.
- **Do not commit `.env`, `.env.*` (except `*.env.base`/`*.env.fork`/`*.env.prod` templates checked in), private keys, or anything under `deployments/<prod>/` that wasn't intentionally tracked.**
- **Do not modify `agents/mrelayer` as a workspace package** — it has its own `package-lock.json` and is excluded from `pnpm-workspace.yaml`. Run `npm install` inside it, not pnpm.
- **`broadcaster` and `bjscan` bundle to CJS** via esbuild — avoid top-level await or ESM-only constructs in their `src/`. Use `packages: "external"` only in dev (`esbuild.dev.mjs`), never in `dist`.
- **Sync IDL/types before merging Solana program changes** — `broadcaster` will silently break against an outdated IDL.
