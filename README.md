# WHM Monorepo (Wormhole Messaging)

Cross-chain oracle price relay from Solana to Hydration parachain via Wormhole and Moonbeam. Solana program reads Kamino Scope oracle prices, ABI-encodes them, and publishes VAAs through Wormhole. On Moonbeam, upgradeable contracts receive, validate, and route messages, then dispatch price updates to Hydration via XCM. See [SCHEMA.md](SCHEMA.md) for the full architecture diagram.

**Parent Setup**

Install workspace dependencies for all submodules:

```bash
pnpm install
```

**Platforms**

Each platform has its own README with prerequisites, build, and test steps:

- [platforms/evm](platforms/evm/README.md)
- [platforms/solana](platforms/solana/README.md)
