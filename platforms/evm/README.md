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
 --seed your_account_seed \
 --address your_account_address
```

### Message Receiver

To run scripts agains local fork use **DOTENV_CONFIG_PATH=.env.fork**.

#### Deploy contract

Deploy the message receiver contract.

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

Registers a trusted emitter contract from a source chain on the receiver.

| Flag             | Description                                  |
| ---------------- | -------------------------------------------- |
| `--pk`           | Private key used to sign the transaction     |
| `--address`      | Contract address                             |
| `--emitter`      | Emitter contract address on the source chain |
| `--source-chain` | Source chain identifier (Wormhole chain ID)  |

```bash
pnpm run receiver:setAuthorizedEmitter -- \
 --pk your_private_key \
 --address receiver_address \
 --emitter emitter_address \
 --source-chain souce_chain_id
```

#### Receive message

Submit a signed VAA (Verified Action Approval) from the Wormhole Guardian network to the receiver contract.
Used for receiving messages from non-EVM chains (e.g. Solana) via Wormhole Core Bridge.

| Flag        | Description                                               |
| ----------- | --------------------------------------------------------- |
| `--pk`      | Private key used to sign the transaction                  |
| `--address` | Contract address                                          |
| `--vaa`     | Hex-encoded signed VAA from the Wormhole Guardian network |

```bash
pnpm run receiver:receiveMessage -- \
 --pk your_private_key \
 --address receiver_address \
 --vaa hex_encoded_vaa
```

### Message Dispatcher

#### Deploy contract

Deploy the message dispatcher contract.

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

Set handler for dispatch action.

| Flag          | Description                              |
| ------------- | ---------------------------------------- |
| `--pk`        | Private key used to sign the transaction |
| `--address`   | Contract address                         |
| `--handler`   | Dispatch handler address                 |
| `--action-id` | Dispatch action id                       |

```bash
pnpm run dispatcher:setHandler -- \
 --pk your_private_key \
 --address dispatcher_address \
 --handler handler_address  \
 --action-id action_id
```

#### Set price oracle

Set oracle address for price update asset.

| Flag         | Description                              |
| ------------ | ---------------------------------------- |
| `--pk`       | Private key used to sign the transaction |
| `--address`  | Contract address                         |
| `--oracle`   | Managed oracle address                   |
| `--asset-id` | Asset id bytes32 address                 |

```bash
pnpm run dispatcher:setOracle -- \
 --pk your_private_key \
 --address dispatcher_address \
 --oracle oracle_address \
 --asset-id asset_id
```

### Xcm Transactor

#### Deploy contract

Deploy xcm transactor contract.

| Flag                    | Description                                                     |
| ----------------------- | --------------------------------------------------------------- |
| `--pk`                  | Private key used to sign the transaction                        |
| `--destination-para-id` | Destination parachain id                                        |
| `--source-para-id`      | Source parachain id                                             |
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

#### Register authorized

Registers a trusted operator on the transactor.

| Flag         | Description                              |
| ------------ | ---------------------------------------- |
| `--pk`       | Private key used to sign the transaction |
| `--address`  | Contract address                         |
| `--operator` | Operator address                         |
| `--enabled`  | Operational flag                         |

```bash
pnpm run transactor:setAuthorized -- \
 --pk your_private_key \
 --address transactor_address \
 --operator operator_address \
 --enabled true
```

#### Register authorized dispatcher

Registers a dispatcher contract as an authorized caller on the transactor.

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

Updates runtime values used by `encodeEvmCall` and `transact`. Caller must be authorized on the transactor.

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

Dispatch an EVM call through the transactor.

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
