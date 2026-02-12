# Solana

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

### Account

#### Get secret

Derive secret from seed & address

| Flag        | Description      |
| ----------- | ---------------- |
| `--seed`    | Accound mnemonic |
| `--addrees` | Accound address  |

```bash
pnpm run account:getSecret -- \
 --seed your_account_seed \
 --address your_account_address
```

### Message sender

To run sender scripts agains local validator use **DOTENV_CONFIG_PATH=.env.fork**.

#### Local validator (fork environment)

Spawn local validator for sender program.

```bash
pnpm sender:runValidator
```

#### Deploy program

Deploy the sender program.

| Flag     | Description                              |
| -------- | ---------------------------------------- |
| `--pk`   | Private key used to sign the transaction |
| `--test` | Use in local environment to airdrop sol  |

```bash
pnpm sender:deploy -- \
 --pk your_private_key \
 --test true
```

#### Cleanup deploy buffers

Close all buffer accounts for your deploy authority to reclaim stranded rent.

| Flag          | Description                                              |
| ------------- | -------------------------------------------------------- |
| `--pk`        | Deploy authority private key used to sign close txs      |
| `--recipient` | Recipient account for reclaimed lamports (optional)      |

```bash
pnpm sender:cleanup -- \
 --pk your_private_key \
 --recipient your_wallet_address
```

#### Close program

Close the deployed sender program and reclaim rent to a recipient account.

| Flag          | Description                                                      |
| ------------- | ---------------------------------------------------------------- |
| `--pk`        | Upgrade authority private key used to sign close transaction     |
| `--programId` | Program id to close (defaults to current sender id from IDL)     |
| `--recipient` | Recipient account for reclaimed lamports (defaults to authority) |

```bash
pnpm sender:close -- \
 --pk your_private_key \
 --programId your_program_id \
 --recipient your_wallet_address
```

#### Broadcast message

Broadcast message to wormhole guardians via core contract.

| Flag        | Description                                          |
| ----------- | ---------------------------------------------------- |
| `--pk`      | Private key used to sign the transaction             |
| `--message` | Message payload to send (string or hex-encoded data) |

```bash
pnpm sender:sendMessage -- \
 --pk your_private_key \
 --message your_message
```

#### Broadcast price

Broadcast price to wormhole guardians via core contract.

| Flag   | Description                              |
| ------ | ---------------------------------------- |
| `--pk` | Private key used to sign the transaction |

```bash
pnpm sender:sendPrice -- \
 --pk your_private_key
```
