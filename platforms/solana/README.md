# Solana

**Prerequisites**

- Rust toolchain (`cargo`)
- Solana CLI (`solana`, `solana-test-validator`)
- Anchor (`anchor`)

Install Rust:

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

Install Solana CLI:

```bash
sh -c "$(curl -sSfL https://release.solana.com/stable/install)"
```

Install Anchor (via AVM):

```bash
cargo install --git https://github.com/coral-xyz/anchor avm --locked
avm install latest
avm use latest
```

**Build**

```bash
cd platforms/solana
pnpm run build
```

**Test**

Start a local validator:

```bash
cd platforms/solana
pnpm run validator
```

In another terminal:

```bash
cd platforms/solana
pnpm run test:validator
```
