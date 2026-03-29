# EVM

Upgradeable Solidity contracts on Moonbeam and other EVM chains. Receives Wormhole messages and dispatches calls to Hydration via XCM, and bridges assets between EVM chains and Hydration via Moonbeam.

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

## Local Forks

```bash
pnpm run fork:base
pnpm run fork:moonbeam
```

## Migrations

See [migration docs](../../docs/migration.md) for general usage, flags, and how the runner works.

### oracle-relay

Deploy and configure the Moonbeam oracle relay stack — XcmTransactor + MessageDispatcher + wiring. Targets a single chain (Moonbeam). Messages flow: Solana emitter → Wormhole → Moonbeam dispatcher → XCM transact → Hydration.

Env files: `oracle-relay.fork.env`

| Env variable | Description                          |
| ------------ | ------------------------------------ |
| `PK`         | Private key for the deployer account |

```bash
PK=0x... pnpm run migrate:oracle-relay -- fork
```

### insta-bridge

Deploy the full InstaBridge stack across three chains — InstaBridgeProxy (Moonbeam), InstaTransfer (Hydration), and InstaBridge (Base or other EVM chain). The script coordinates the deployment sequence, pausing between phases to wire cross-chain references.

Env files: `insta-bridge-proxy.fork.env`, `insta-transfer.fork.env`, `insta-bridge.fork.env`

| Env variable   | Description                                              |
| -------------- | -------------------------------------------------------- |
| `PK_IPROXY`    | Private key for the InstaBridgeProxy deployer (Moonbeam) |
| `PK_ITRANSFER` | Private key for the InstaTransfer deployer (Hydration)   |
| `PK_IBRIDGE`   | Private key for the InstaBridge deployer (e.g. Base)     |

```bash
PK_IPROXY=0x... PK_ITRANSFER=0x... PK_IBRIDGE=0x... \
  pnpm run migrate:insta-bridge -- fork
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

### Emitter

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
npx tsx scripts/emitter/sendMessage.ts \
  --pk your_private_key \
  --address emitter_address \
  --message "hello world"
```

### Receiver

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
npx tsx scripts/receiver/receiveMessage.ts \
  --pk your_private_key \
  --address receiver_address \
  --vaa hex_encoded_vaa
```

### Transactor

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
npx tsx scripts/transactor/transact.ts \
  --pk your_private_key \
  --address transactor_address \
  --target target_contract_address \
  --input encoded_calldata_hex
```

### InstaBridge

#### Bridge via Wormhole

Initiate a cross-chain bridge transfer. Approves the asset, fetches the Wormhole message fee, and calls `bridgeViaWormhole`.

| Env variable | Description        |
| ------------ | ------------------ |
| `RPC`        | Chain RPC endpoint |
| `CHAIN_ID`   | Chain ID (EVM)     |

| Flag           | Description                              |
| -------------- | ---------------------------------------- |
| `--pk`         | Private key used to sign the transaction |
| `--address`    | InstaBridge contract address             |
| `--asset`      | ERC20 token address to bridge            |
| `--amount`     | Amount in native token units             |
| `--dest-chain` | Destination Wormhole chain ID            |
| `--dest-asset` | Destination asset address                |
| `--recipient`  | Recipient address (bytes32)              |

```bash
npx tsx scripts/instaBridge/bridgeViaWormhole.ts \
  --pk your_private_key \
  --address insta_bridge_address \
  --asset token_address \
  --amount 1000000 \
  --dest-chain dest_wormhole_chain_id \
  --dest-asset dest_asset_address \
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
| `--address` | InstaBridge contract address                              |
| `--vaa`     | Hex-encoded signed VAA from the Wormhole Guardian network |

```bash
npx tsx scripts/instaBridge/completeTransfer.ts \
  --pk your_private_key \
  --address insta_bridge_address \
  --vaa hex_encoded_vaa
```
