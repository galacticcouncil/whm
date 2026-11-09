# WHM (Wormhole Messaging)

Cross-chain infrastructure connecting EVM chains, Solana, NEAR, Sui and Hydration via Wormhole. Handles oracle price relay, instant token bridging, intent-driven swaps, and NEAR / Zcash corridors — through upgradeable contracts, an Anchor program, NEAR contracts, and off-chain agents.

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              MONOREPO (pnpm)                                    │
│                                                                                 │
│  ┌──────────────┐   ┌────────────────────────┐   ┌──────────────────────────┐   │
│  │   common/    │   │      contracts/        │   │      crates/             │   │
│  │              │   │                        │   │                          │   │
│  │  - args      │◄──┤   Solidity (Foundry)   │   │  - solana  (Anchor)      │──►│
│  │  - evm       │   └────────────────────────┘   │  - near    (near-sdk)    │   │
│  │  - migration │                                └──────────────────────────┘   │
│  └──────────────┘                                                               │
│                                                                                 │
│  ┌────────────────────────────────────────────────────────────────────────────┐ │
│  │                          migrations/  (cross-platform)                     │ │
│  └────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                 │
│  ┌────────────────────────────────────────────────────────────────────────────┐ │
│  │                          agents/  (off-chain)                              │ │
│  │   broadcaster — Rate publisher                                             │ │
│  │   scan        — Data indexer                                               │ │
│  │   relayer     — VAA relayer (ntt, oracles, intent)                         │ │
│  │   utxo        — UTXO withdraw relayer (NEAR)                               │ │
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

### Near NTT

NEAR tokens move NEAR ↔ Hydration in one hop over native NTT. `ntt-manager` on NEAR is manager + transceiver in one, LOCKING, one deployment per token; Hydration runs a stock EVM NttManager.

- [Spec](docs/near-ntt/spec.md)
- [Crate](crates/near/README.md)

### Near UTXO

UTXO-chain coins to and from their native chain through Omni, one deployment per chain. Deposits are proven on the chain's Omni connector and carried over NTT to Hydration. Withdrawals go the chain's UTXO emitter (Hydration) → NTT to NEAR → `utxo-withdraw` MPC-signs the Omni withdrawal for the account derived from the destination address, and the `utxo` agent relays it.

- [Deposit](docs/near-utxo/deposit/spec.md)
- [Withdraw](docs/near-utxo/withdraw/spec.md)

## Setup

```bash
pnpm install                              # workspace deps
pnpm --filter @whm/contracts install      # forge soldeer install
pnpm --filter @whm/contracts build        # forge build
pnpm --filter @whm/crates-solana build    # anchor build -p oracle-emitter
pnpm --filter @whm/crates-near build      # cargo near build (ntt-manager, utxo-withdraw)
pnpm --filter @whm/crates-near test       # unit tests; test:sandbox for end-to-end
```

## Repo layout

```
contracts/      # Foundry (Solidity) — @whm/contracts
crates/         # Cargo workspaces — @whm/crates-solana, @whm/crates-near
migrations/     # Cross-platform deploy pipelines
deployments/    # Migration state files (prod/, fork/)
agents/         # Off-chain services (broadcaster, scan, relayer, intent, utxo)
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
pnpm fork:robinhood     # anvil :8551
pnpm fork:hyper-evm     # anvil :8552
pnpm fork:solana        # solana-test-validator :8898 (Wormhole + Oracle clone)
pnpm fork:all           # all evm forks in parallel

# Run migrations (against fork or prod)
pnpm migrate:basejump-base:fork
pnpm migrate:basejump-base                  # prod
pnpm migrate:oracle-relay-solana:fork
pnpm migrate:oracle-relay-solana            # prod
pnpm migrate:oracle-relay-ethereum:fork
pnpm migrate:oracle-relay-ethereum          # prod
pnpm migrate:governance-hydration:fork
pnpm migrate:governance-hydration           # prod; run before destination migrations
pnpm migrate:governance-robinhood:fork
pnpm migrate:governance-robinhood           # prod
pnpm migrate:governance-ethereum:fork
pnpm migrate:governance-ethereum            # prod
pnpm migrate:governance-hyper-evm:fork
pnpm migrate:governance-hyper-evm           # prod
pnpm migrate:governance-base:fork
pnpm migrate:governance-base                # prod
pnpm migrate:near-ntt-zec                   # prod (NEAR side; Hydration side is hydration-ntt's)
pnpm migrate:near-ntt-near                  # prod
pnpm migrate:utxo-emitter-zec               # prod
pnpm migrate:utxo-withdraw-zec              # prod

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
| `@whm/crates-near`   | `crates/near/`        | NEAR contracts + per-package scripts       |
| `@whm/broadcaster`   | `agents/broadcaster/` | Price/rate publisher                       |
| `@whm/scan`          | `agents/scan/`        | Data indexer (intent/basejump)             |
| `@whm/relayer`       | `agents/relayer/`     | VAA relayer (ntt, oracle, intent)          |
| `@whm/intent`        | `agents/intent/`      | Intents off-chain (quoter, 1Click relayer) |
| `@whm/utxo`          | `agents/utxo/`        | UTXO withdrawals (account api, relayer)    |
