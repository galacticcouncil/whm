# WHM (Wormhole Messaging)

Cross-chain infrastructure connecting EVM chains, Solana, Sui and Hydration via Wormhole. Handles oracle price relay, instant token bridging, and intent-driven swaps — through upgradeable contracts, an Anchor program, and off-chain agents.

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
│  │   broadcaster — Price/rate publisher                                       │ │
│  │   scan        — Data indexer                                               │ │
│  │   relayer     — VAA relayer (ntt, oracles, intent)                         │ │
│  └────────────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────────┘
```

## Use cases

### Oracle Relay

Solana program reads Kamino Scope oracle prices + SPL stake pool rates and broadcasts them through Wormhole to a Hydration receiver, which forwards price updates to Hydration's on-chain oracle. Ethereum-source variant uses an EVM `OracleEmitter` reading wstETH / apyUSD rates directly.

- [Spec](docs/oracle/spec.md)

### Basejump

Instant cross-chain token bridging from EVM source chains to Hydration. A fast-path message pays the user in ~2 min out of a pre-funded landing pool; a slow Wormhole NTT settlement replenishes the pool in the background (~13 min).

- [Spec](docs/basejump/spec.md)
- [Schema](docs/basejump/schema.md)
- [Indexer](docs/basejump/indexer.md)

### Intents

Hydration users buy any NEAR-Intents supported asset (BTC, ZEC, NEAR,…) via OneClick quotes. A single Hydration extrinsic swaps the user's chosen asset to WETH and bridges it via Wormhole; `IntentReceiver` forwards native ETH into the quote's `depositAddress` on Ethereum, atomically with the fast-path delivery.

- [Spec](docs/intents/spec.md)
- [Schema](docs/intents/schema.md)
- [Fee](docs/intents/fee.md)
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
agents/         # Off-chain services (broadcaster, scan, relayer, intent)
common/         # @whm/common — shared TS (evm, args, migration)
sh/             # Cross-cutting bash wrappers (fork-*, migrate-*, verify-*)
docs/           # Cross-cutting protocol docs
```

## Common operations

```bash
# Local forks
pnpm fork:base          # anvil :8546
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

| Package              | Path                  | Purpose                                    |
| -------------------- | --------------------- | ------------------------------------------ |
| `@whm/common`        | `common/`             | Shared TS (chains, wallet, migration)      |
| `@whm/contracts`     | `contracts/`          | Foundry project + per-package scripts      |
| `@whm/crates-solana` | `crates/solana/`      | Anchor workspace + per-package scripts     |
| `@whm/crates-near`   | `crates/near/`        | Near contracts + per-package scripts       |
| `@whm/broadcaster`   | `agents/broadcaster/` | Price/rate publisher                       |
| `@whm/scan`          | `agents/scan/`        | Data indexer (intent/basejump)             |
| `@whm/relayer`       | `agents/relayer/`     | VAA relayer (ntt, oracle, intent)          |
| `@whm/intent`        | `agents/intent/`      | Intents off-chain (quoter, 1Click relayer) |
