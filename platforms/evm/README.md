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

## Scripts

Standalone operational scripts. Use **DOTENV_CONFIG_PATH** to select the target environment.

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
DOTENV_CONFIG_PATH=.env.fork pnpm run script:emitter:send-message -- \
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
DOTENV_CONFIG_PATH=.env.fork pnpm run script:receiver:receive-message -- \
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
DOTENV_CONFIG_PATH=.env.fork pnpm run script:transactor:transact -- \
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
DOTENV_CONFIG_PATH=envs/.env.base pnpm run script:insta-bridge:bridge-via-wormhole -- \
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
DOTENV_CONFIG_PATH=envs/.env.base pnpm run script:insta-bridge:complete-transfer -- \
  --pk your_private_key \
  --address insta_bridge_address \
  --vaa hex_encoded_vaa
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
      index.ts           # Config (name, description, setup)
      001-deploy-transactor.ts
      002-deploy-dispatcher.ts
      ...
  envs/                  # Per-migration env files
    oracle-relay.moonbeam.env
    oracle-relay.fork.env
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
  --env moonbeam \
  --pk your_private_key
```

| Flag          | Description                                        |
| ------------- | -------------------------------------------------- |
| `--migration` | Migration name (folder under `definitions/`)       |
| `--env`       | Environment name (`moonbeam`, `fork`, `base`, etc) |
| `--pk`        | Private key used to sign transactions              |
| `--from`      | Reset and re-run from this step onward             |
| `--dry-run`   | Preview steps without executing                    |

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
  --env moonbeam \
  --pk your_private_key \
  --from set-oracle-prime
```

### Available migrations

#### oracle-relay

Deploy and configure the Moonbeam oracle relay stack (transactor + dispatcher).

**Steps:**

1. `deploy-transactor` — Deploy XcmTransactor UUPS proxy
2. `deploy-dispatcher` — Deploy MessageDispatcher UUPS proxy
3. `authorize-dispatcher` — Grant dispatcher authorization on transactor
4. `register-emitter` — Register trusted Wormhole emitter on dispatcher
5. `set-handler` — Map action ID to oracle handler
6. `set-oracle-prime` — Register PRIME oracle on dispatcher

**Env files:** `oracle-relay.moonbeam.env`, `oracle-relay.fork.env`

### Available actions

Actions are pure functions under `migrations/actions/` that can be composed into migration steps.

| Module          | Action                 | Description                                         |
| --------------- | ---------------------- | --------------------------------------------------- |
| `dispatcher`    | `deploy`               | Deploy MessageDispatcher UUPS proxy                 |
| `emitter`       | `deploy`               | Deploy MessageEmitter UUPS proxy                    |
| `receiver`      | `deploy`               | Deploy MessageReceiver UUPS proxy                   |
| `receiver`      | `setAuthorizedEmitter` | Register trusted emitter on receiver                |
| `transactor`    | `deploy`               | Deploy XcmTransactor UUPS proxy                     |
| `transactor`    | `setAuthorized`        | Grant/revoke operator on transactor                 |
| `transactor`    | `setDefaults`          | Set XCM gas, weight, and fee parameters             |
| `instaBridge`   | `deploy`               | Deploy InstaBridge UUPS proxy                       |
| `instaBridge`   | `deployProxy`          | Deploy InstaBridgeProxy UUPS proxy                  |
| `instaBridge`   | `setAuthorizedEmitter` | Register trusted emitter on InstaBridge             |
| `instaBridge`   | `setFeeBps`            | Update fee in basis points                          |
| `instaBridge`   | `setInstaTransfer`     | Register InstaTransfer address for a Wormhole chain |
| `instaBridge`   | `setXcmTransactor`     | Set XCM transactor on InstaBridgeProxy              |
| `instaTransfer` | `deploy`               | Deploy InstaTransfer UUPS proxy                     |
| `instaTransfer` | `setAuthorizedBridge`  | Authorize/revoke bridge on InstaTransfer            |

### Creating a new migration

1. Create a folder under `migrations/definitions/`:

```
migrations/definitions/my-migration/
  index.ts
  001-first-step.ts
  002-second-step.ts
```

2. Export a config from `index.ts`:

```typescript
import type { MigrationConfig } from "../../types";
import { wallet } from "../../../lib";

const config: MigrationConfig = {
  name: "my-migration",
  description: "What this migration does",
  setup: (env, pk) => {
    const rpcUrl = env.RPC;
    const chainId = env.CHAIN_ID;
    if (!rpcUrl) throw new Error("Missing RPC");
    if (!chainId) throw new Error("Missing CHAIN_ID");
    return wallet.getWallet(rpcUrl, Number(chainId), pk);
  },
};

export default config;
```

3. Export a step from each `NNN-*.ts` file:

```typescript
import type { MigrationStep } from "../../types";
import { deployDispatcher } from "../../actions/dispatcher/deploy";

const step: MigrationStep = {
  name: "deploy-dispatcher",
  description: "Deploy MessageDispatcher UUPS proxy",
  action: async (ctx) => {
    return await deployDispatcher({
      ...ctx.wallet,
      wormholeCore: ctx.env.WORMHOLE_CORE as `0x${string}`,
    });
  },
};

export default step;
```

4. Create env files at `migrations/envs/my-migration.{env}.env`.
