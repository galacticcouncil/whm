# WHM Monorepo (Wormhole Messaging)

Generic cross-chain messaging framework built on Wormhole. A Solana program ABI-encodes arbitrary payloads and publishes them as VAAs. On Moonbeam, upgradeable EVM contracts receive, validate, and route messages, then dispatch actions to destination parachains via XCM. The action-based routing is extensible — new message types plug in without changing the core pipeline.

The first use case is **oracle price relay**: the Solana program reads Kamino Scope oracle prices and broadcasts them through Wormhole to Moonbeam, which forwards price updates to Hydration's on-chain oracle via XCM.

See [SCHEMA.md](SCHEMA.md) for the full architecture diagram.

**Parent Setup**

Install workspace dependencies for all submodules:

```bash
pnpm install
```

**Platforms**

Each platform has its own README with prerequisites, build, and test steps:

- [platforms/evm](platforms/evm/README.md)
- [platforms/solana](platforms/solana/README.md)
