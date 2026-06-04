# WHM (Wormhole Messaging)

Cross-chain infrastructure connecting EVM chains, Solana, and Hydration via Moonbeam. Handles oracle price relay, instant token bridging, and intent-driven swaps — through upgradeable contracts, an Anchor program, and off-chain agents.

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              MONOREPO (pnpm)                                    │
│                                                                                 │
│  ┌──────────────┐   ┌────────────────────────┐   ┌──────────────────────────┐   │
│  │   common/    │   │      contracts/        │   │      crates/             │   │
│  │              │   │                        │   │                          │   │
│  │  - args      │◄──┤   Solidity (Foundry)   │   │  Anchor / Cargo (Rust)   │──►│
│  │  - evm       │   └────────────────────────┘   └──────────────────────────┘   |
│  │  - migration │                                                               │
│  └──────────────┘                                                               │
│                                                                                 │
│  ┌────────────────────────────────────────────────────────────────────────────┐ │
│  │                          migrations/  (cross-platform)                     │ │
│  └────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                 │
│  ┌────────────────────────────────────────────────────────────────────────────┐ │
│  │                          agents/  (off-chain)                              │ │
│  │   broadcaster — Solana → Wormhole price/rate publisher                     │ │
│  │   bjscan      — Basejump indexer                                           │ │
│  │   mrelayer    — Wormhole relayer-engine (legacy, not a pnpm member)        │ │
│  └────────────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────────┘
```

## Use cases

### Oracle Relay

Solana program reads Kamino Scope oracle prices + SPL stake pool rates and broadcasts them through Wormhole to a Moonbeam dispatcher, which forwards price updates to Hydration's on-chain oracle via XCM. Ethereum-source variant uses an EVM `OracleEmitter` reading wstETH / apyUSD rates directly.

- [Spec](docs/oracle/spec.md)
- [Schema](docs/oracle/schema.md)

### Basejump

Instant cross-chain token bridging between EVM source chains and Hydration via Moonbeam. Fast-path settles in ~2 min against a pre-funded landing pool; slow Wormhole Token Bridge transfer replenishes the pool in the background (~13 min).

- [Spec](docs/basejump/spec.md)
- [Schema](docs/basejump/schema.md)
- [Indexer](docs/basejump/indexer.md)

### NEAR Intents

Hydration users buy any NEAR-Intents-supported asset (BTC, ZEC, NEAR-native, Solana SPLs, …) via OneClick quotes. A Hydration-initiated dual-transport (Snowbridge + MRL) deposits native ETH into the quote's `depositAddress` on Ethereum atomically.

- [Spec](docs/intents/spec.md)
- [Schema](docs/intents/schema.md)
- [Refund](docs/intents/refund.md)

## Setup

```bash
pnpm install                              # workspace deps
pnpm --filter @whm/contracts install      # forge soldeer install
pnpm --filter @whm/contracts build        # forge build
pnpm --filter @whm/crates-solana build    # anchor build -p oracle-emitter
```

## Repo layout

```
contracts/      # Foundry (Solidity) — @whm/contracts
crates/         # Anchor / Cargo workspaces — @whm/crates-solana (extensible)
migrations/     # Cross-platform deploy pipelines
deployments/    # Migration state files (prod/, fork/)
agents/         # Off-chain services (broadcaster, bjscan, mrelayer)
common/         # @whm/common — shared TS (evm, args, migration)
sh/             # Cross-cutting bash wrappers (fork-*, migrate-*, verify-*)
docs/           # Cross-cutting protocol docs
```

## Common operations

```bash
# Local forks
pnpm fork:base          # anvil :8546
pnpm fork:moonbeam      # anvil :8545
pnpm fork:hydration     # anvil :8547
pnpm fork:ethereum      # anvil :8550
pnpm fork:solana        # solana-test-validator :8898 (Wormhole + Oracle clone)
pnpm fork:all           # all evm forks in parallel

# Run migrations (against fork or prod)
pnpm migrate:basejump-base:fork
pnpm migrate:basejump-base                  # prod
pnpm migrate:oracle-relay-solana:fork
pnpm migrate:oracle-relay-solana            # prod
pnpm migrate:oracle-relay-ethereum:fork
pnpm migrate:oracle-relay-ethereum          # prod

# Print MRL oracle state
pnpm print:oracles
```

See [migrations/README.md](migrations/README.md) for the migration model, naming conventions, and full flag reference.

## Workspace packages

| Package              | Path                  | Purpose                                |
| -------------------- | --------------------- | -------------------------------------- |
| `@whm/common`        | `common/`             | Shared TS (chains, wallet, migration)  |
| `@whm/contracts`     | `contracts/`          | Foundry project + per-package scripts  |
| `@whm/crates-solana` | `crates/solana/`      | Anchor workspace + per-package scripts |
| `@whm/broadcaster`   | `agents/broadcaster/` | Solana → Wormhole price/rate publisher |
| `@whm/bjscan`        | `agents/bjscan/`      | Basejump indexer + Fastify API         |

`agents/mrelayer` ships its own `package-lock.json` and is intentionally NOT a pnpm workspace member.

## Conventions

- **Commit messages**: `scope: description` (lowercase, imperative). Common scopes: `oracle`, `basejump`, `intents`, `bjscan` ...
- **Migration naming**: deploy-first NNN order, `@<contract>` suffix for setters. See [migrations/README.md](migrations/README.md).
- **Renounced ownership**: every prod-ready migration ends with `transfer-ownership@*` (to a custodian) or `renounce@*` (to `0x0`).
