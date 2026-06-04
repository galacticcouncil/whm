# Solana

Anchor program that ABI-encodes arbitrary messages and oracle data, then publishes them as VAAs through Wormhole Core Bridge.

## Prerequisites

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

## Build

```bash
pnpm run build
```

## Test

Start a local validator:

```bash
pnpm run validator
```

In another terminal:

```bash
pnpm run test:validator
```

## Scripts

### Account

#### Get secret

Derive a wallet secret from a mnemonic seed and account address.

| Flag        | Description      |
| ----------- | ---------------- |
| `--seed`    | Account mnemonic |
| `--address` | Account address  |

```bash
npx tsx scripts/getSecret.ts \
 --seed your_account_seed \
 --address your_account_address
```

### Asset

#### Get bytes32

Convert a Solana public key to its bytes32 hex representation (used for cross-chain asset IDs).

| Flag   | Description              |
| ------ | ------------------------ |
| `--id` | Solana public key string |

```bash
npx tsx scripts/getBytes32.ts \
 --id your_public_key
```

### Oracle Emitter

#### Local validator (fork environment)

Spawn a local Solana test validator pre-loaded with the oracle-emitter program and Wormhole accounts.

```bash
npx tsx scripts/oracle-emitter/runValidator.ts
```

#### Close program

Close the deployed program and reclaim rent lamports to a recipient account.

| Flag          | Description                                                           |
| ------------- | --------------------------------------------------------------------- |
| `--pk`        | Upgrade authority private key used to sign close transaction          |
| `--programId` | Program id to close (defaults to current oracle-emitter id from IDL) |
| `--recipient` | Recipient account for reclaimed lamports (defaults to authority)      |

```bash
npx tsx scripts/oracle-emitter/close.ts \
 --pk your_private_key \
 --programId your_program_id \
 --recipient your_wallet_address
```

#### Broadcast oracle price

Read the latest Scope oracle price for a registered asset and publish it as a Wormhole VAA.

| Flag      | Description                               |
| --------- | ----------------------------------------- |
| `--pk`    | Private key used to sign the transaction  |
| `--asset` | Solana public key of the registered asset |

```bash
npx tsx scripts/oracle-emitter/sendPrice.ts \
 --pk your_private_key \
 --asset 3b8X44fLF9ooXaUm3hhSgjpmVs6rZZ3pPoGnGahc3Uu7
```

#### Broadcast stake pool rate

Read the SOL exchange rate from a registered SPL Stake Pool and publish it as a Wormhole VAA.

| Flag      | Description                               |
| --------- | ----------------------------------------- |
| `--pk`    | Private key used to sign the transaction  |
| `--asset` | Solana public key of the registered asset |

```bash
npx tsx scripts/oracle-emitter/sendRate.ts \
 --pk your_private_key \
 --asset J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn
```
