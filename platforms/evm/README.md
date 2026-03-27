# EVM

Upgradeable Solidity contracts deployed on Moonbeam that receive Wormhole messages, route them by action type, and dispatch calls to Hydration parachain via XCM.

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

Sequentially executed, crash-safe deployment pipelines. Each migration is a folder containing a config (`index.ts`) and numbered step files (`NNN-*.ts`) that are auto-discovered and run in order.

### Structure

```
migrations/
  runner.ts              # Execution engine
  run.ts                 # CLI entry point
  types.ts               # Shared type definitions
  actions/               # Reusable action functions
    dispatcher/
    instaBridge/
    instaTransfer/
    transactor/
    ...
  definitions/           # Migration definitions
    oracle-relay/
    insta-bridge/
    insta-bridge-proxy/
    insta-transfer/
  envs/                  # Per-migration env files
    oracle-relay.fork.env
    oracle-relay.moon.env
    insta-bridge.fork.env
    insta-bridge.base.env
    ...
```

### How it works

1. **Env loading** — Runner loads `migrations/envs/{migration}.{env}.env`. Shell variables take precedence over file values.
2. **Setup** — Each migration's `index.ts` exports a `setup` function that reads env vars and creates a wallet context.
3. **Step discovery** — Files matching `NNN-*.ts` are sorted and executed sequentially.
4. **State persistence** — After each step, state is saved to `deployments/{env}/{migration}.json`. On re-run, completed steps are skipped.
5. **Output passing** — Each step returns a `Record<string, string>`. Subsequent steps access prior outputs via `ctx.outputs["step-name"].field`.

### Usage

```bash
pnpm run migration:run -- \
  --migration oracle-relay \
  --env fork \
  --pk your_private_key
```

| Flag          | Description                                    |
| ------------- | ---------------------------------------------- |
| `--migration` | Migration name (folder under `definitions/`)   |
| `--env`       | Environment name (`moon`, `fork`, `base`, etc) |
| `--pk`        | Private key used to sign transactions          |
| `--from`      | Reset and re-run from this step onward         |
| `--to`        | Stop after this step (inclusive)               |
| `--dry-run`   | Preview steps without executing                |

Dry run:

```bash
pnpm run migration:dry-run -- \
  --migration oracle-relay \
  --env fork \
  --pk your_private_key
```

Re-run from a specific step:

```bash
pnpm run migration:run -- \
  --migration oracle-relay \
  --env fork \
  --pk your_private_key \
  --from deploy-dispatcher
```

### Available migrations

#### oracle-relay

Deploy and configure the Moonbeam oracle relay stack — XcmTransactor + MessageDispatcher + wiring. Targets a single chain (Moonbeam). Messages flow: Solana emitter → Wormhole → Moonbeam dispatcher → XCM transact → Hydration.

Env files: `oracle-relay.fork.env`

| Env variable | Description                          |
| ------------ | ------------------------------------ |
| `PK`         | Private key for the deployer account |

```bash
PK=0x... pnpm run migrate:oracle-relay -- fork
```

#### insta-bridge

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

Standalone operational scripts. Use **DOTENV_CONFIG_PATH** if targeting .env environments.

### Account

#### Get secret

Derive a wallet private key from a mnemonic seed and account address.

| Flag        | Description      |
| ----------- | ---------------- |
| `--seed`    | Account mnemonic |
| `--address` | Account address  |

```bash
pnpm run script:account:get-secret -- \
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
pnpm run script:emitter:send-message -- \
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
pnpm run script:receiver:receive-message -- \
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
pnpm run script:transactor:transact -- \
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
pnpm run script:insta-bridge:bridge-via-wormhole -- \
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
pnpm run script:insta-bridge:complete-transfer -- \
  --pk your_private_key \
  --address insta_bridge_address \
  --vaa hex_encoded_vaa
```
