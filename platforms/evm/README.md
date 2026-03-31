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

Run individual forks:

```bash
pnpm run fork:base
pnpm run fork:moonbeam
pnpm run fork:hydration
```

Or run all forks together in parallel:

```bash
pnpm run fork:all
```

Ports:

- Moonbeam: `http://127.0.0.1:8545`
- Base: `http://127.0.0.1:8546`
- Hydration: `http://127.0.0.1:8547`

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

### basejump

Deploy the full Basejump stack across three chains — BasejumpProxy (Moonbeam), BasejumpLanding (Hydration), and Basejump (Base or other EVM chain). The script coordinates the deployment sequence and wire cross-chain references.

Env files: `basejump-proxy.env`, `basejump-landing.env`, `basejump.env`, `basejump-proxy-setup.env`

**Environment variables can be provided via:**

1. Command line (as shown below)
2. `.env` file in `platforms/evm/` directory (automatically loaded if present)

| Env variable | Description                                              |
| ------------ | -------------------------------------------------------- |
| `PK_PROXY`   | Private key for the BasejumpProxy deployer (Moonbeam)    |
| `PK_LANDING` | Private key for the BasejumpLanding deployer (Hydration) |
| `PK`         | Private key for the Basejump deployer (e.g. Base)        |

**Optional configuration (basejump-landing.env):**

See basejump-landing `set-dest-asset_{{asset}}.ts` definition.

| Env variable             | Description                                                   |
| ------------------------ | ------------------------------------------------------------- |
| `{{asset}}_SOURCE_ASSET` | Source chain asset address to map (e.g., Base EURC)           |
| `{{asset}}_DEST_ASSET`   | Destination asset address on Hydration (e.g., Hydration EURC) |

**Optional configuration (basejump.env):**

See basejump `set-asset-fee_{{asset}}.ts` definition.

| Env variable           | Description                                           |
| ---------------------- | ----------------------------------------------------- |
| `{{asset}}_FEE_ASSET`  | Asset address to set fee for                          |
| `{{asset}}_FEE_AMOUNT` | Fee amount in token units (e.g., 100000 for 0.1 EURC) |

**Via command line:**

```bash
PK=0x... PK_PROXY=0x... PK_LANDING=0x... \
  pnpm run migrate:basejump -- base
```

**Via .env file:**

```bash
# Create .env file in platforms/evm/
# PK_PROXY=0x...
# PK_LANDING=0x...
# PK=0x...

pnpm run migrate:basejump -- base
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
