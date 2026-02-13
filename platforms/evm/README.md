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

| Flag   | Description                              |
| ------ | ---------------------------------------- |
| `--pk` | Private key used to sign the transaction |

```bash
pnpm run receiver:deploy -- \
 --pk your_private_key
```

#### Verify contract

Verify the message receiver contract.

| Flag        | Description                              |
| ----------- | ---------------------------------------- |
| `--pk`      | Private key used to sign the transaction |
| `--address` | Contract address                         |

```bash
pnpm run receiver:verify -- \
 --pk your_private_key \
 --address receiver_address \
```

#### Register authorized emitter

Registers a trusted emitter contract from a source chain on the receiver.

| Flag             | Description                                  |
| ---------------- | -------------------------------------------- |
| `--pk`           | Private key used to sign the transaction     |
| `--address`      | Contract address                             |
| `--emitter`      | Emitter contract address on the source chain |
| `--source-chain` | Source chain identifier (Wormhole chain ID)  |

```bash
pnpm run receiver:registerSender -- \
 --pk your_private_key \
 --address receiver_address \
 --emitter emitter_address \
 --source-chain souce_chain_id
```

#### Register authorized operator

Registers a trusted operator on the receiver.

| Flag         | Description                              |
| ------------ | ---------------------------------------- |
| `--pk`       | Private key used to sign the transaction |
| `--address`  | Contract address                         |
| `--operator` | Operator address                         |
| `--enabled`  | Operational flag                         |

```bash
pnpm run receiver:registerUpdater -- \
 --pk your_private_key \
 --address receiver_address \
 --updater operator_address \
 --enabled true
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

#### Set handler

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

#### Set oracle

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

### Message Relayer

#### Deploy contract

Deploy the message relayer contract.

| Flag   | Description                              |
| ------ | ---------------------------------------- |
| `--pk` | Private key used to sign the transaction |

```bash
pnpm run relayer:deploy -- \
 --pk your_private_key
```

#### Send message to receiver

Send message to receiver contract via wormhole relayer.

| Flag             | Description                                          |
| ---------------- | ---------------------------------------------------- |
| `--pk`           | Private key used to sign the transaction             |
| `--address`      | Contract address                                     |
| `--receiver`     | Receiver contract address on the target chain        |
| `--target-chain` | Receiver chain identifier (Wormhole chain ID)        |
| `--message`      | Message payload to send (string or hex-encoded data) |

```bash
pnpm run relayer:sendMessage -- \
 --pk your_private_key \
 --address relayer_address \
 --receiver receiver_address \
 --target-chain receiver_chain_id \
 --message your_message
```

### Xcm Transactor

#### Set handler

Set handler for dispatch action.

| Flag                    | Description                              |
| ----------------------- | ---------------------------------------- |
| `--pk`                  | Private key used to sign the transaction |
| `--destination-para-id` | Destination parachain id                 |
| `--source-para-id`      | Source parachain id                      |
| `--evm-pallet-index`    | Pallet index for Hydration EVM transact  |
| `--evm-call-index`      | Call index for Hydration EVM transact    |
| `--fee-asset`           | XC-20 token used for XCM execution fees  |

```bash
pnpm run transactor:deploy -- \
 --pk your_private_key \
 --destination-para-id dst_para_id \
 --source-para-id src_para_id \
 --evm-pallet-index evm_pallet_index \
 --evm-call-index evm_call_index \
 --fee-asset fee_asset_xc20
```

Example:

```bash
DOTENV_CONFIG_PATH=.env.fork pnpm run transactor:deploy -- \
 --pk 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
 --destination-para-id 2034 \
 --source-para-id 2004 \
 --evm-pallet-index 36 \
 --evm-call-index 0 \
 --fee-asset '0xFFFfFfff345Dc44DDAE98Df024Eb494321E73FcC'
```
