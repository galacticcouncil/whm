# Contracts

Upgradeable Solidity contracts on Moonbeam and other EVM chains. Receives Wormhole messages and dispatches calls to Hydration via XCM, and bridges assets between EVM chains and Hydration via Moonbeam.

## Prerequisites

- Foundry (`forge`, `anvil`)

Install Foundry:

```bash
curl -L https://foundry.paradigm.xyz | bash
foundryup
```

## Install

```bash
pnpm run install
```

## Build

```bash
pnpm run build
```

## Test

```bash
pnpm run test
```

## Scripts

Standalone operational scripts. Use **DOTENV_CONFIG_PATH** for targeting .env variables.

### Account

#### Get secret

Derive a wallet private key from a mnemonic seed and account address.

| Flag        | Description      |
| ----------- | ---------------- |
| `--seed`    | Account mnemonic |
| `--address` | Account address  |

```bash
npx tsx scripts/getSecret.ts \
  --seed your_account_seed \
  --address your_account_address
```

### Message Emitter

#### Send message

Publish a message to the Wormhole network through the emitter contract.

| Env variable | Description        |
| ------------ | ------------------ |
| `RPC`        | Chain RPC endpoint |
| `CHAIN_ID`   | Chain ID (EVM)     |

| Flag        | Description                              |
| ----------- | ---------------------------------------- |
| `--pk`      | Private key used to sign the transaction |
| `--address` | Emitter contract address                 |
| `--message` | Message string to publish                |

```bash
npx tsx scripts/message-emitter/sendMessage.ts \
  --pk your_private_key \
  --address emitter_address \
  --message "hello world"
```

### Message Receiver

#### Receive message

Submit a signed VAA to the receiver for on-chain validation and processing.

| Env variable | Description        |
| ------------ | ------------------ |
| `RPC`        | Chain RPC endpoint |
| `CHAIN_ID`   | Chain ID (EVM)     |

| Flag        | Description                                               |
| ----------- | --------------------------------------------------------- |
| `--pk`      | Private key used to sign the transaction                  |
| `--address` | Receiver contract address                                 |
| `--vaa`     | Hex-encoded signed VAA from the Wormhole Guardian network |

```bash
npx tsx scripts/message-receiver/receiveMessage.ts \
  --pk your_private_key \
  --address receiver_address \
  --vaa hex_encoded_vaa
```

### Xcm Transactor

#### Transact

Dispatch an EVM call to the destination parachain through XCM.

| Env variable | Description        |
| ------------ | ------------------ |
| `RPC`        | Chain RPC endpoint |
| `CHAIN_ID`   | Chain ID (EVM)     |

| Flag        | Description                                      |
| ----------- | ------------------------------------------------ |
| `--pk`      | Private key used to sign the transaction         |
| `--address` | Transactor contract address                      |
| `--target`  | Target contract address on destination parachain |
| `--input`   | Hex-encoded calldata (0x...)                     |

```bash
npx tsx scripts/xcm-transactor/transact.ts \
  --pk your_private_key \
  --address transactor_address \
  --target target_contract_address \
  --input encoded_calldata_hex
```

### Basejump

#### Bridge via Wormhole

Initiate a cross-chain bridge transfer. Approves the asset, fetches the Wormhole message fee, and calls `bridgeViaWormhole`. Bridges to Hydration via Moonbeam (destination is hardcoded).

| Env variable | Description        |
| ------------ | ------------------ |
| `RPC`        | Chain RPC endpoint |
| `CHAIN_ID`   | Chain ID (EVM)     |

| Flag          | Description                              |
| ------------- | ---------------------------------------- |
| `--pk`        | Private key used to sign the transaction |
| `--address`   | Basejump contract address                |
| `--asset`     | ERC20 token address to bridge            |
| `--amount`    | Amount in native token units             |
| `--recipient` | Recipient address (bytes32)              |

```bash
npx tsx scripts/basejump/bridgeViaWormhole.ts \
  --pk your_private_key \
  --address basejump_address \
  --asset token_address \
  --amount 1000000 \
  --recipient recipient_bytes32
```

#### Complete transfer

Submit a signed VAA to complete a fast-path transfer on the destination chain.

| Env variable | Description        |
| ------------ | ------------------ |
| `RPC`        | Chain RPC endpoint |
| `CHAIN_ID`   | Chain ID (EVM)     |

| Flag        | Description                                               |
| ----------- | --------------------------------------------------------- |
| `--pk`      | Private key used to sign the transaction                  |
| `--address` | Basejump contract address                                 |
| `--vaa`     | Hex-encoded signed VAA from the Wormhole Guardian network |

```bash
npx tsx scripts/basejump/completeTransfer.ts \
  --pk your_private_key \
  --address basejump_address \
  --vaa hex_encoded_vaa
```

### Basejump Landing

#### Add route

Authorize a corridor bridge (XcmTransactor MDA) and map a source-chain asset to its Hydration destination asset on the landing. Both calls are `onlyOwner` (Hydration TC); reads current state and prints the owner calldata for governance by default, or submits directly with `--send` if you hold the owner key (e.g. on a fork). Idempotent — skips whatever is already set.

| Env variable | Description        |
| ------------ | ------------------ |
| `RPC`        | Chain RPC endpoint |
| `CHAIN_ID`   | Chain ID (EVM)     |

| Flag        | Description                                                      |
| ----------- | --------------------------------------------------------------- |
| `--landing` | BasejumpLanding address (or `HYDRATION_LANDING` env)            |
| `--bridge`  | Authorized bridge = XcmTransactor MDA (or `BRIDGE_MDA` env)     |
| `--source`  | Source-chain asset address (or `USDC_SOURCE_ASSET` env)         |
| `--dest`    | Hydration destination asset (or `USDC_DEST_ASSET` env)          |
| `--send`    | Submit directly (requires `PK_LANDING` / `PK` / `--pk` = owner) |

```bash
RPC=https://rpc.hydradx.cloud CHAIN_ID=222222 \
npx tsx scripts/basejump-landing/addRoute.ts \
  --landing 0x70e9b12c3b19cb5f0e59984a5866278ab69df976 \
  --bridge 0x9fbba2ffe461aa3aa93fb85305191e531e115e14 \
  --source 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 \
  --dest 0x0000000000000000000000000000000100000015
```
