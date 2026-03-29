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
cd platforms/solana
pnpm run build
```

## Test

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

## Scripts

Standalone operational scripts. Use **DOTENV_CONFIG_PATH** for targeting .env variables.

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

### Message Emitter

To run scripts against local validator use **DOTENV_CONFIG_PATH=.env.fork**.

#### Local validator (fork environment)

Spawn a local Solana test validator pre-loaded with the message-emitter program and Wormhole accounts.

```bash
npx tsx scripts/emitter/runValidator.ts
```

#### Deploy program

Deploy the message-emitter program to the configured cluster.

| Flag     | Description                              |
| -------- | ---------------------------------------- |
| `--pk`   | Private key used to sign the transaction |
| `--test` | Use in local environment to airdrop sol  |

```bash
npx tsx scripts/emitter/deploy.ts \
 --pk your_private_key \
 --test true
```

#### Close program

Close the deployed program and reclaim rent lamports to a recipient account.

| Flag          | Description                                                           |
| ------------- | --------------------------------------------------------------------- |
| `--pk`        | Upgrade authority private key used to sign close transaction          |
| `--programId` | Program id to close (defaults to current message-emitter id from IDL) |
| `--recipient` | Recipient account for reclaimed lamports (defaults to authority)      |

```bash
npx tsx scripts/emitter/close.ts \
 --pk your_private_key \
 --programId your_program_id \
 --recipient your_wallet_address
```

#### Broadcast message

Publish a string message as a Wormhole VAA through the Core Bridge.

| Flag        | Description                                          |
| ----------- | ---------------------------------------------------- |
| `--pk`      | Private key used to sign the transaction             |
| `--message` | Message payload to send (string or hex-encoded data) |

```bash
npx tsx scripts/emitter/sendMessage.ts \
 --pk your_private_key \
 --message your_message
```

#### Broadcast price

Read the latest oracle price and publish it as a Wormhole VAA.

| Flag   | Description                              |
| ------ | ---------------------------------------- |
| `--pk` | Private key used to sign the transaction |

```bash
npx tsx scripts/emitter/sendPrice.ts \
 --pk your_private_key
```
