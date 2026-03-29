# WHM (Wormhole Messaging)

Cross-chain infrastructure built on Wormhole connecting EVM chains, Solana, and Hydration via Moonbeam. Handles oracle price relay, instant token bridging, and extensible message routing — all through upgradeable contracts and off-chain agents.

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              MONOREPO (pnpm)                                    │
│                                                                                 │
│  ┌──────────┐   ┌──────────────────────────┐   ┌────────────────────────────┐   │
│  │  common/ │   │    platforms/solana/     │   │      platforms/evm/        │   │
│  │          │   │                          │   │                            │   │
│  │  - args  │◄──┤  Anchor Program (Rust)   │   │  Foundry Contracts (Sol)   │──►│
│  │  - utils │   │  TypeScript Scripts      │   │  TypeScript Scripts        │   │
│  │  - migr. │   └──────────────────────────┘   └────────────────────────────┘   │
│  └──────────┘                                                                   │
│                                                                                 │
│  ┌──────────────────────────────────────────────────────────────────────────┐   │
│  │                          agents/ (off-chain)                             │   │
│  │                                                                          │   │
│  │  ┌──────────────────┐   ┌──────────────────┐   ┌───────────────────┐     │   │
│  │  │  Broadcaster     │   │  Relayer         │   │  <<Custom>>       │     │   │
│  │  │                  │   │                  │   │                   │     │   │
│  │  │  Triggers price  │   │  Polls Wormhole  │   │                   │     │   │
│  │  │  broadcasts on   │   │  for signed VAAs │   │                   │     │   │
│  │  │  Solana          │   │  → submits to    │   │                   │     │   │
│  │  │                  │   │    Evm/Solana/.. │   │                   │     │   │
│  │  └──────────────────┘   └──────────────────┘   └───────────────────┘     │   │
│  └──────────────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────────┘
```

## Use Cases

### Oracle Relay

Solana program reads Kamino Scope oracle prices and broadcasts them through Wormhole to Moonbeam, which forwards price updates to Hydration's on-chain oracle via XCM.

- [Spec](docs/oracle/spec.md)
- [Schema](docs/oracle/schema.md)

### Insta Bridge

Instant cross-chain token bridging between EVM chains and Hydration via Moonbeam. Users get tokens on the destination chain immediately (~60s) while the slow Wormhole Token Bridge transfer settles in the background (~13 min).

- [Spec](docs/instabridge/spec.md)
- [Schema](docs/instabridge.schema.md)

## Setup

Install workspace dependencies for all submodules:

```bash
pnpm install
```

## Platforms

Each platform has its own README with prerequisites, build, test & deploy steps:

- [platforms/evm](platforms/evm/README.md)
- [platforms/solana](platforms/solana/README.md)
