# Wormhole Message Emitter Program

## Context

On Solana, cross-chain messaging works through the Wormhole Core Bridge's `post_message` instruction. Guardians observe the message, produce a signed VAA, and the relayer network delivers it to the target EVM chain.

## Implementation

### Program state: `Config` (PDA, seeds: `[b"config"]`)

| Field            | Type       | Description                                   |
| ---------------- | ---------- | --------------------------------------------- |
| `owner`          | `Pubkey`   | Admin who can update config                   |
| `wormhole`       | `Pubkey`   | Wormhole Core Bridge program ID               |
| `target_chain`   | `u16`      | Wormhole chain ID of receiver (16 = Moonbeam) |
| `target_address` | `[u8; 32]` | Receiver contract address in Wormhole format  |

### Instructions

#### 1. `initialize(target_chain: u16, target_address: [u8; 32])`

- Creates the `Config` PDA
- Stores owner, Wormhole program ID, target chain/address
- One-time setup

#### 2. `send_message(message: String)`

- **Permissionless** (matches EVM sender - anyone can send and pay the fee)
- ABI-encodes the message string for EVM receiver compatibility
- CPI to Wormhole Core Bridge `post_message`

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

**Instruction data format:**

```
[0x01]                    // PostMessage instruction index
[nonce: u32 LE]           // Message nonce (0)
[payload_len: u32 LE]     // Borsh Vec length prefix
[payload bytes]           // ABI-encoded message
[consistency_level: u8]   // 1 = confirmed finality
```

### ABI encoding (EVM compatibility)

The Moonbeam receiver does `abi.decode(payload, (string))`. The Solana message-emitter program must produce valid ABI encoding:

```
bytes  0-31: offset to string data = 0x20 (32, big-endian)
bytes 32-63: string byte length (big-endian u256)
bytes 64+:   UTF-8 string data, zero-padded to 32-byte boundary
```

### Key design decisions

- **Wormhole program ID is configurable** - passed at init, not hardcoded. Works for devnet (`3u8hJUVTA4jH1wYAyUur7FFZVQ8H635K3tSHHF4ssjQ5`) and mainnet (`worm2ZoG2kUd4vFXhvjh93UUH596ayRfgQ2MgjNMTth`)

- **No external Wormhole crate** - raw CPI avoids anchor version compatibility issues with `wormhole-anchor-sdk` (targets anchor 0.29.x, we use 0.32.x)

- **Payload encodes only the message string** - matches what the receiver decodes. The EVM sender also encodes `msg.sender` but the receiver ignores it

- **Emitter PDA as message source** - the Wormhole guardian network uses this as the sender identity. The Moonbeam receiver must register this emitter address (in bytes32 format) via `setRegisteredSender(1, emitterBytes32)` where Wormhole chain ID `1` = Solana
