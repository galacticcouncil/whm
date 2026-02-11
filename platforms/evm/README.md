# EVM

## Prerequisites

- Foundry (`forge`, `anvil`)

Install Foundry:

```bash
curl -L https://foundry.paradigm.xyz | bash
foundryup
```

## Build

```bash
cd platforms/evm
pnpm run build
```

## Test

```bash
cd platforms/evm
pnpm run test
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
 --address 0x
```

### Message Receiver

#### Deploy contract (fork environment)

Deploy the message receiver contract.

| Flag   | Description                              |
| ------ | ---------------------------------------- |
| `--pk` | Private key used to sign the transaction |

```bash
DOTENV_CONFIG_PATH=.env.fork pnpm run receiver:deploy -- \
 --pk 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
```

#### Verify contract (fork environment)

Verify the message receiver contract.

| Flag        | Description                              |
| ----------- | ---------------------------------------- |
| `--pk`      | Private key used to sign the transaction |
| `--address` | Receiver contract address                |

```bash
DOTENV_CONFIG_PATH=.env.fork pnpm run receiver:verify -- \
 --pk 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
 --address 0xa513e6e4b8f2a923d98304ec87f64353c4d5c853 \
```

#### Register sender on receiver (fork environment)

Registers a trusted sender contract from a source chain on the receiver.

| Flag             | Description                                 |
| ---------------- | ------------------------------------------- |
| `--pk`           | Private key used to sign the transaction    |
| `--address`      | Receiver contract address                   |
| `--sender`       | Sender contract address on the source chain |
| `--source-chain` | Source chain identifier (Wormhole chain ID) |

```bash
DOTENV_CONFIG_PATH=.env.fork pnpm run receiver:registerSender -- \
 --pk 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
 --address 0xa513e6e4b8f2a923d98304ec87f64353c4d5c853 \
 --sender 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 \
 --source-chain 30
```

#### Register updater (bot) on receiver (fork environment)

Registers a trusted updater (boot) on the receiver.

| Flag        | Description                                 |
| ----------- | ------------------------------------------- |
| `--pk`      | Private key used to sign the transaction    |
| `--address` | Receiver contract address                   |
| `--updater` | Sender contract address on the source chain |
| `--enabled` | Source chain identifier (Wormhole chain ID) |

```bash
DOTENV_CONFIG_PATH=.env.fork pnpm run receiver:registerUpdater -- \
 --pk 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
 --address 0xa513e6e4b8f2a923d98304ec87f64353c4d5c853 \
 --updater 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 \
 --enabled true
```

#### Receive message (fork environment)

Submit a signed VAA (Verified Action Approval) from the Wormhole Guardian network to the receiver contract. Used for receiving messages from non-EVM chains (e.g. Solana) via Wormhole Core Bridge.

| Flag        | Description                                               |
| ----------- | --------------------------------------------------------- |
| `--pk`      | Private key used to sign the transaction                  |
| `--address` | Receiver contract address                                 |
| `--vaa`     | Hex-encoded signed VAA from the Wormhole Guardian network |

```bash
DOTENV_CONFIG_PATH=.env.fork pnpm run receiver:receiveMessage -- \
 --pk 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
 --address 0xa513e6e4b8f2a923d98304ec87f64353c4d5c853 \
 --vaa 1/abc/0
```

### Message Relayer

#### Deploy contract (fork environment)

Deploy the message relayer contract.

| Flag   | Description                              |
| ------ | ---------------------------------------- |
| `--pk` | Private key used to sign the transaction |

```bash
DOTENV_CONFIG_PATH=.env.fork pnpm run relayer:deploy -- \
 --pk 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
```

#### Send message to receiver (fork environment)

Send message to receiver contract via wormhole relayer.

| Flag             | Description                                          |
| ---------------- | ---------------------------------------------------- |
| `--pk`           | Private key used to sign the transaction             |
| `--address`      | Sender contract address                              |
| `--receiver`     | Receiver contract address on the target chain        |
| `--target-chain` | Target chain identifier (Wormhole chain ID)          |
| `--message`      | Message payload to send (string or hex-encoded data) |

```bash
DOTENV_CONFIG_PATH=.env.fork pnpm run relayer:sendMessage -- \
 --pk 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
 --address 0x11231a3757acd34ba4810691a71c637f2b46c473 \
 --receiver 0xa513e6e4b8f2a923d98304ec87f64353c4d5c853 \
 --target-chain 16 \
 --message 'Hello from source!'
```
