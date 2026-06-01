# Wormhole Message Emitter Program

## Context

On Solana, cross-chain messaging works through the Wormhole Core Bridge's `post_message` instruction. Guardians observe the message, produce a signed VAA, and the relayer network delivers it to the target EVM chain.

## Implementation

### Program state

#### `Config` (PDA, seeds: `[b"config"]`)

| Field   | Type     | Description                 |
| ------- | -------- | --------------------------- |
| `owner` | `Pubkey` | Admin who can update config |

#### `PriceFeed` (PDA, seeds: `[b"price_feed", asset_id]`)

| Field         | Type       | Description                         |
| ------------- | ---------- | ----------------------------------- |
| `asset_id`    | `[u8; 32]` | Asset identity (pubkey bytes)       |
| `price_index` | `u16`      | Kamino Scope oracle index for asset |

#### `StakePoolFeed` (PDA, seeds: `[b"stake_pool_feed", asset_id]`)

| Field        | Type       | Description                    |
| ------------ | ---------- | ------------------------------ |
| `asset_id`   | `[u8; 32]` | Asset identity (pubkey bytes)  |
| `stake_pool` | `Pubkey`   | SPL Stake Pool account address |

### Instructions

#### 1. `initialize()`

- Creates the `Config` PDA
- Stores owner
- One-time setup

#### 2. `register_price_feed(asset_id, price_index)`

- Creates a `PriceFeed` PDA binding an asset to a Kamino Scope oracle index
- Owner-only

#### 3. `register_pool_feed(asset_id, stake_pool)`

- Creates a `StakePoolFeed` PDA binding an asset to an SPL Stake Pool
- Owner-only

#### 4. `send_message(message: String)`

- **Permissionless** (matches EVM sender - anyone can send and pay the fee)
- ABI-encodes the message string for EVM receiver compatibility
- CPI to Wormhole Core Bridge `post_message`

#### 5. `send_price()`

- **Permissionless**
- Reads `DatedPrice` from Kamino Scope oracle at the registered `price_index`
- Normalizes price to 18 decimals
- ABI-encodes payload with `ACTION_ORACLE_PRICE` (1)
- CPI to Wormhole Core Bridge `post_message`

#### 6. `send_rate()`

- **Permissionless**
- Reads `total_lamports` and `pool_token_supply` from the registered SPL Stake Pool
- Computes asset/SOL rate (`total_lamports / pool_token_supply`) normalized to 18 decimals
- ABI-encodes payload with `ACTION_STAKE_RATE` (2)
- CPI to Wormhole Core Bridge `post_message`

### Payload format

Both `send_price` and `send_rate` produce the same ABI-encoded layout, decoded on EVM as:

```
abi.decode(payload, (uint8, bytes32, uint256, uint64))
```

| Field     | Type      | Description                           |
| --------- | --------- | ------------------------------------- |
| action    | `uint8`   | 1 = oracle price, 2 = stake pool rate |
| assetId   | `bytes32` | Asset identity (Solana pubkey bytes)  |
| price     | `uint256` | Value normalized to 18 decimals       |
| timestamp | `uint64`  | Oracle timestamp or clock timestamp   |

### Wormhole Core Bridge CPI (`post_message`)

**Accounts** (in order):

1. `wormhole_bridge` - Bridge config PDA (seeds: `[b"Bridge"]`, Wormhole program)
2. `wormhole_message` - New Keypair per message (signer, writable) - client generates
3. `emitter` - Our program's PDA (seeds: `[b"emitter"]`) - signed via `invoke_signed`
4. `sequence` - Sequence tracker PDA (seeds: `[b"Sequence", emitter_key]`, Wormhole program)
5. `payer` - Transaction signer/fee payer (writable)
6. `fee_collector` - Wormhole fee account (seeds: `[b"fee_collector"]`, Wormhole program)
7. `clock` - Clock sysvar
8. `rent` - Rent sysvar
9. `system_program` - System program

### ABI encoding (EVM compatibility)

**String encoding** (`send_message`):

```
bytes  0-31: offset to string data = 0x20 (32, big-endian)
bytes 32-63: string byte length (big-endian u256)
bytes 64+:   UTF-8 string data, zero-padded to 32-byte boundary
```

**Price/rate encoding** (`send_price`, `send_rate`):

```
bytes   0-31:  action    (uint8, left-padded to 32 bytes)
bytes  32-63:  assetId   (bytes32)
bytes  64-95:  price     (uint256, 18-decimal normalised, big-endian)
bytes  96-127: timestamp (uint64, left-padded to 32 bytes)
```

### Key design decisions

- **Wormhole program ID is configurable** - passed at init, not hardcoded. Works for devnet (`3u8hJUVTA4jH1wYAyUur7FFZVQ8H635K3tSHHF4ssjQ5`) and mainnet (`worm2ZoG2kUd4vFXhvjh93UUH596ayRfgQ2MgjNMTth`)

- **No external Wormhole crate** - raw CPI avoids anchor version compatibility issues with `wormhole-anchor-sdk` (targets anchor 0.29.x, we use 0.32.x)

- **Payload encodes only the message string** - matches what the receiver decodes. The EVM sender also encodes `msg.sender` but the receiver ignores it

- **Emitter PDA as message source** - the Wormhole guardian network uses this as the sender identity. The Moonbeam receiver must register this emitter address (in bytes32 format) via `setAuthorizedEmitter(1, emitterBytes32)` where Wormhole chain ID `1` = Solana

- **Two feed types** - `PriceFeed` for oracle-sourced USD prices (Kamino Scope), `StakePoolFeed` for on-chain SOL exchange rates (SPL Stake Pool). Separate PDAs keep concerns clean — `price_index` is meaningless for stake pools and `stake_pool` is meaningless for oracle feeds

- **Stake pool address validated on-chain** - `SendRate` enforces `#[account(address = stake_pool_feed.stake_pool)]` so the caller cannot pass a different stake pool than what the owner registered

### Scope oracle mappings

Price feed index-to-asset mappings: https://github.com/Kamino-Finance/scope/tree/master/configs/mainnet
