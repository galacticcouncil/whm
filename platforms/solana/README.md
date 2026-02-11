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
 --seed 'word1 word2 ... word12' \
 --address GRpBoLhKQaHkrEocwqYu5jDUNNC8cFMjpCedVEAB32ob \
```

### Message sender

#### Deploy program (fork environment)

Deploy the message relayer contract.

| Flag   | Description                              |
| ------ | ---------------------------------------- |
| `--pk` | Private key used to sign the transaction |

```bash
DOTENV_CONFIG_PATH=.env.fork pnpm run sender:deploy -- \
 --pk '5BTqGoQihN3....rf7YJJWu' \
 --test true
```

#### Broadcast message (fork environment)

Send message to receiver contract via wormhole relayer.

| Flag        | Description                                          |
| ----------- | ---------------------------------------------------- |
| `--pk`      | Private key used to sign the transaction             |
| `--message` | Message payload to send (string or hex-encoded data) |

```bash
DOTENV_CONFIG_PATH=.env.fork pnpm sender:sendMessage -- \
 --pk '5BTqGoQihN3....rf7YJJWu'
 --message "hello"
```
