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

## Scripts

### Account

#### Get secret

Derive a wallet secret from a mnemonic seed and account address.

| Flag        | Description      |
| ----------- | ---------------- |
| `--seed`    | Account mnemonic |
| `--address` | Account address  |

```bash
pnpm run account:getSecret -- \
 --seed your_account_seed \
 --address your_account_address
```

### Message Emitter

Publishes messages to the Wormhole network via the core bridge contract.

To run scripts against local fork use **DOTENV_CONFIG_PATH=.env.fork**.

#### Deploy contract

Deploy or upgrade the MessageEmitter UUPS proxy.

| Flag      | Description                                                     |
| --------- | --------------------------------------------------------------- |
| `--pk`    | Private key used to sign the transaction                        |
| `--proxy` | Deploys new implementation and upgrades existing proxy in-place |

```bash
pnpm run emitter:deploy -- \
 --pk your_private_key
 --proxy emitter_proxy_address
```

When `--proxy` is used, only implementation code is upgraded. Existing proxy storage is preserved, so `initialize()` defaults are not re-applied.

#### Send message

Publish a message to the Wormhole network through the emitter contract.

| Flag        | Description                              |
| ----------- | ---------------------------------------- |
| `--pk`      | Private key used to sign the transaction |
| `--address` | Emitter contract address                 |
| `--message` | Message string to publish                |

```bash
pnpm run emitter:sendMessage -- \
 --pk your_private_key \
 --address emitter_address \
 --message "hello world"
```

### Message Receiver

Receives and validates Wormhole VAAs, enforces emitter authorization and replay protection.

To run scripts against local fork use **DOTENV_CONFIG_PATH=.env.fork**.

#### Deploy contract

Deploy or upgrade the MessageReceiver UUPS proxy.

| Flag      | Description                                                     |
| --------- | --------------------------------------------------------------- |
| `--pk`    | Private key used to sign the transaction                        |
| `--proxy` | Deploys new implementation and upgrades existing proxy in-place |

```bash
pnpm run receiver:deploy -- \
 --pk your_private_key
 --proxy receiver_proxy_address
```

When `--proxy` is used, only implementation code is upgraded. Existing proxy storage is preserved, so `initialize()` defaults are not re-applied.

#### Register authorized emitter

Whitelist a trusted emitter from a source chain so the receiver accepts its VAAs.

| Flag             | Description                                  |
| ---------------- | -------------------------------------------- |
| `--pk`           | Private key used to sign the transaction     |
| `--address`      | Receiver contract address                    |
| `--emitter`      | Emitter contract address on the source chain |
| `--source-chain` | Source chain identifier (Wormhole chain ID)  |

```bash
pnpm run receiver:setAuthorizedEmitter -- \
 --pk your_private_key \
 --address receiver_address \
 --emitter emitter_address \
 --source-chain source_chain_id
```

#### Receive message

Submit a signed VAA to the receiver for on-chain validation and processing.

| Flag        | Description                                               |
| ----------- | --------------------------------------------------------- |
| `--pk`      | Private key used to sign the transaction                  |
| `--address` | Receiver contract address                                 |
| `--vaa`     | Hex-encoded signed VAA from the Wormhole Guardian network |

```bash
pnpm run receiver:receiveMessage -- \
 --pk your_private_key \
 --address receiver_address \
 --vaa hex_encoded_vaa
```

### Message Dispatcher

Extends MessageReceiver to decode ABI payloads, route by action ID, and forward to registered handlers.

#### Deploy contract

Deploy or upgrade the MessageDispatcher UUPS proxy.

| Flag      | Description                                                     |
| --------- | --------------------------------------------------------------- |
| `--pk`    | Private key used to sign the transaction                        |
| `--proxy` | Deploys new implementation and upgrades existing proxy in-place |

```bash
pnpm run dispatcher:deploy -- \
 --pk your_private_key
 --proxy dispatcher_proxy_address
```

When `--proxy` is used, only implementation code is upgraded. Existing proxy storage is preserved, so `initialize()` defaults are not re-applied.

#### Set dispatch handler

Map an action ID to a handler contract that processes that action type.

| Flag          | Description                              |
| ------------- | ---------------------------------------- |
| `--pk`        | Private key used to sign the transaction |
| `--address`   | Dispatcher contract address              |
| `--handler`   | Handler contract address                 |
| `--action-id` | Action ID to route                       |

```bash
pnpm run dispatcher:setHandler -- \
 --pk your_private_key \
 --address dispatcher_address \
 --handler handler_address  \
 --action-id action_id
```

#### Set price oracle

Map an asset ID to its managed oracle contract address on the destination chain.

| Flag         | Description                              |
| ------------ | ---------------------------------------- |
| `--pk`       | Private key used to sign the transaction |
| `--address`  | Dispatcher contract address              |
| `--oracle`   | Oracle contract address                  |
| `--asset-id` | Asset ID (bytes32)                       |

```bash
pnpm run dispatcher:setOracle -- \
 --pk your_private_key \
 --address dispatcher_address \
 --oracle oracle_address \
 --asset-id asset_id
```

### InstaBridge

Bridges funds into/out of Hydration via Wormhole TokenBridge and fast-path VAAs. Each chain has its own env file (`.env.base`, `.env.moonbeam`, etc.) with `IBRI_*` variables. Select the target chain with **DOTENV_CONFIG_PATH**.

| Env variable         | Description                  |
| -------------------- | ---------------------------- |
| `IBRI_RPC`           | Chain RPC endpoint           |
| `IBRI_CHAIN_ID`      | Chain ID (EVM)               |
| `IBRI_WORMHOLE_CORE` | Wormhole core bridge address |
| `IBRI_WORMHOLE_ID`   | Wormhole chain ID            |
| `IBRI_TOKEN_BRIDGE`  | Wormhole TokenBridge address |

#### Deploy contract

Deploy or upgrade the InstaBridge UUPS proxy on a source EVM chain.

| Flag      | Description                                                     |
| --------- | --------------------------------------------------------------- |
| `--pk`    | Private key used to sign the transaction                        |
| `--proxy` | Deploys new implementation and upgrades existing proxy in-place |

```bash
DOTENV_CONFIG_PATH=envs/.env.base pnpm run instaBridge:deploy -- \
 --pk your_private_key \
 --proxy insta_bridge_proxy_address
```

When `--proxy` is used, only implementation code is upgraded. Existing proxy storage is preserved, so `initialize()` defaults are not re-applied.

#### Deploy proxy contract

Deploy or upgrade the InstaBridgeProxy UUPS proxy on Moonbeam. Routes funds out from Hydration to external chains and forwards fast-path VAAs via XCM.

| Flag      | Description                                                     |
| --------- | --------------------------------------------------------------- |
| `--pk`    | Private key used to sign the transaction                        |
| `--proxy` | Deploys new implementation and upgrades existing proxy in-place |

```bash
DOTENV_CONFIG_PATH=.env.moonbeam pnpm run instaBridge:deployProxy -- \
 --pk your_private_key \
 --proxy insta_bridge_proxy_address
```

When `--proxy` is used, only implementation code is upgraded. Existing proxy storage is preserved, so `initialize()` defaults are not re-applied.

#### Set InstaTransfer

Register the InstaTransfer contract address for a given Wormhole chain ID.

| Flag               | Description                              |
| ------------------ | ---------------------------------------- |
| `--pk`             | Private key used to sign the transaction |
| `--address`        | InstaBridge contract address             |
| `--wh-chain-id`    | Wormhole chain ID (uint16)               |
| `--insta-transfer` | InstaTransfer address (bytes32)          |

```bash
DOTENV_CONFIG_PATH=.env.base pnpm run instaBridge:setInstaTransfer -- \
 --pk your_private_key \
 --address insta_bridge_address \
 --wh-chain-id wormhole_chain_id \
 --insta-transfer insta_transfer_bytes32
```

#### Set fee BPS

Update the fee in basis points (1 bp = 0.01%, default 10 bp = 0.1%).

| Flag        | Description                              |
| ----------- | ---------------------------------------- |
| `--pk`      | Private key used to sign the transaction |
| `--address` | InstaBridge contract address             |
| `--fee-bps` | Fee in basis points (uint256)            |

```bash
DOTENV_CONFIG_PATH=.env.base pnpm run instaBridge:setFeeBps -- \
 --pk your_private_key \
 --address insta_bridge_address \
 --fee-bps 10
```

#### Register authorized emitter

Whitelist a trusted emitter from a source chain so the InstaBridge accepts its VAAs.

| Flag             | Description                                 |
| ---------------- | ------------------------------------------- |
| `--pk`           | Private key used to sign the transaction    |
| `--address`      | InstaBridge contract address                |
| `--emitter`       | Emitter contract address (address or bytes32) |
| `--emitter-chain` | Emitter chain identifier (Wormhole chain ID)  |

```bash
DOTENV_CONFIG_PATH=.env.base pnpm run instaBridge:setAuthorizedEmitter -- \
 --pk your_private_key \
 --address insta_bridge_address \
 --emitter emitter_bytes32 \
 --emitter-chain emitter_chain_id
```

#### Bridge via Wormhole

Initiate a cross-chain bridge transfer. Approves the asset, fetches the Wormhole message fee, and calls `bridgeViaWormhole`.

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
DOTENV_CONFIG_PATH=envs/.env.base pnpm run instaBridge:bridgeViaWormhole -- \
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

| Flag        | Description                                               |
| ----------- | --------------------------------------------------------- |
| `--pk`      | Private key used to sign the transaction                  |
| `--address` | InstaBridge contract address                              |
| `--vaa`     | Hex-encoded signed VAA from the Wormhole Guardian network |

```bash
DOTENV_CONFIG_PATH=envs/.env.base pnpm run instaBridge:completeTransfer -- \
 --pk your_private_key \
 --address insta_bridge_address \
 --vaa hex_encoded_vaa
```

#### Set XCM transactor

Set the XCM transactor address on InstaBridgeProxy (Moonbeam only).

| Flag               | Description                              |
| ------------------ | ---------------------------------------- |
| `--pk`             | Private key used to sign the transaction |
| `--address`        | InstaBridgeProxy contract address        |
| `--xcm-transactor` | XCM transactor contract address          |

```bash
DOTENV_CONFIG_PATH=.env.moonbeam pnpm run instaBridge:setXcmTransactor -- \
 --pk your_private_key \
 --address insta_bridge_proxy_address \
 --xcm-transactor xcm_transactor_address
```

### XCM Transactor

Assembles and dispatches XCM messages to execute EVM calls on Hydration parachain via the Moonbeam XCM precompile.

#### Deploy contract

Deploy or upgrade the XcmTransactor UUPS proxy with parachain and fee configuration.

| Flag                    | Description                                                     |
| ----------------------- | --------------------------------------------------------------- |
| `--pk`                  | Private key used to sign the transaction                        |
| `--destination-para-id` | Destination parachain ID                                        |
| `--source-para-id`      | Source parachain ID                                             |
| `--evm-pallet-index`    | Pallet index for Hydration EVM transact                         |
| `--evm-call-index`      | Call index for Hydration EVM transact                           |
| `--fee-asset`           | XC-20 token used for XCM execution fees                         |
| `--proxy`               | Deploys new implementation and upgrades existing proxy in-place |

```bash
pnpm run transactor:deploy -- \
 --pk your_private_key \
 --destination-para-id dst_para_id \
 --source-para-id src_para_id \
 --evm-pallet-index evm_pallet_index \
 --evm-call-index evm_call_index \
 --fee-asset fee_asset_xc20 \
 --proxy transactor_proxy_address
```

Example:

```bash
pnpm run transactor:deploy -- \
 --pk your_private_key \
 --destination-para-id 2034 \
 --source-para-id 2004 \
 --evm-pallet-index 90 \
 --evm-call-index 1 \
 --fee-asset '0xFFFfFfff345Dc44DDAE98Df024Eb494321E73FcC'
```

When `--proxy` is used, only implementation code is upgraded. Existing proxy storage is preserved, so `initialize()` defaults are not re-applied.

#### Register authorized operator

Grant or revoke operator privileges on the transactor.

| Flag         | Description                              |
| ------------ | ---------------------------------------- |
| `--pk`       | Private key used to sign the transaction |
| `--address`  | Transactor contract address              |
| `--operator` | Operator address                         |
| `--enabled`  | Enable or disable (`true`/`false`)       |

```bash
pnpm run transactor:setAuthorized -- \
 --pk your_private_key \
 --address transactor_address \
 --operator operator_address \
 --enabled true
```

#### Register authorized dispatcher

Authorize a dispatcher contract to call `transact()` on the transactor.

| Flag           | Description                              |
| -------------- | ---------------------------------------- |
| `--pk`         | Private key used to sign the transaction |
| `--address`    | Transactor contract address              |
| `--dispatcher` | Dispatcher contract address              |
| `--enabled`    | Optional flag (`true` by default)        |

```bash
pnpm run transactor:setAuthorizedDispatcher -- \
 --pk your_private_key \
 --address transactor_address \
 --dispatcher dispatcher_address \
 --enabled true
```

#### Set XCM defaults

Update gas, weight, and fee parameters used for XCM transact calls.

| Flag                    | Description                              |
| ----------------------- | ---------------------------------------- |
| `--pk`                  | Private key used to sign the transaction |
| `--address`             | Transactor contract address              |
| `--gas-limit`           | `xcmGasLimit` (uint64)                   |
| `--max-fee-per-gas`     | `xcmMaxFeePerGas` (uint256)              |
| `--transact-weight`     | `xcmTransactWeight` (uint64)             |
| `--transact-proof-size` | `xcmTransactProofSize` (uint64)          |
| `--fee-amount`          | `xcmFeeAmount` (uint256)                 |

```bash
pnpm run transactor:setDefaults -- \
 --pk your_private_key \
 --address transactor_address \
 --gas-limit 400000 \
 --max-fee-per-gas 10000000 \
 --transact-weight 2000000000 \
 --transact-proof-size 20000 \
 --fee-amount 5000000000000
```

#### Transact

Dispatch an EVM call to the destination parachain through XCM.

| Flag        | Description                                      |
| ----------- | ------------------------------------------------ |
| `--pk`      | Private key used to sign the transaction         |
| `--address` | Transactor contract address                      |
| `--target`  | Target contract address on destination parachain |
| `--input`   | Hex-encoded calldata (0x...)                     |

```bash
pnpm run transactor:transact -- \
 --pk your_private_key \
 --address transactor_address \
 --target target_contract_address \
 --input encoded_calldata_hex
```
