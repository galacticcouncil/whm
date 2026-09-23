# NEAR NTT

## Abstract

A native NTT harness for NEAR, so ZEC and NEAR move **NEAR ↔ Hydration in one hop**, over Wormhole
alone. NEAR is the hub: `zec.omft.near` and `wrap.near` are **locked** in an NTT contract on NEAR,
and Hydration **burns and mints**, the same shape as every live per-token NTT route.

No NEAR NTT exists publicly — `native-token-transfers` ships `evm`, `solana`, `sui` and `xrpl` — and
Wormhole has not answered. Nothing requires one to exist first: NTT is permissionless, and Wormhole on
NEAR is too. Any account can register as an emitter on `contract.wormhole_crypto.near`, and the
guardians observe every message it publishes.

The Hydration side is an unmodified NTT deployment. Only the NEAR contract is new.

The two-hop Omni → Solana → NTT corridor in [../near/spec.md](../near/spec.md) is the fallback if
this slips. The two cannot feed the same Hydration token — see [Hub](#hub).

## Scope

- Both directions, NEAR ↔ Hydration.
- Tokens: ZEC (`zec.omft.near`) and NEAR (`wrap.near`). One NEAR contract per token, as on Solana.
- LOCKING on NEAR only. NEAR is never a burning spoke here: neither token's mint authority is ours.
- Out of scope: native Zcash (reached through `zec.omft.near`), and any relayer fee on the NEAR
  redeem leg (v1 self-redeems; see [Relaying](#relaying)).

## Why not Omni

Omni already locks these tokens on NEAR — ~101,706 `zec.omft.near` sits in `omni.bridge.near`
backing Omni's Solana and EVM mints — so the patterns this contract needs (lock via
`ft_on_transfer`, storage deposits, async callbacks) are proven on this exact token. What Omni adds
on top is a second trust stack: NEAR MPC signing for outbound, a trusted-relayer gate, and a Solana
admin that can replace the MPC key. This contract replaces all of it with the guardians.

## Architecture

| Component               | Chain     | Role                                                                    | Status                         |
| ----------------------- | --------- | ----------------------------------------------------------------------- | ------------------------------ |
| `ntt-<token>.<ours>.near` | NEAR    | NttManager + Wormhole transceiver in one contract, LOCKING, per token   | **new** (Rust, `crates/near`)  |
| Wormhole core           | NEAR      | `contract.wormhole_crypto.near` — `publish_message`, `verify_vaa`       | existing                       |
| `NttManager`            | Hydration | BURNING, per token                                                      | **new deploy**, standard v2    |
| `WormholeTransceiver`   | Hydration | per token                                                               | **new deploy**, standard       |
| `ntt` app               | relayer   | NEAR → Hydration VAAs                                                    | existing — add routes          |
| `near-ntt` app          | relayer   | Hydration → NEAR VAAs (optional in v1)                                  | **new**                        |

Manager and transceiver are one contract on NEAR, as Solana bakes the transceiver into its manager.
Splitting them buys multi-transceiver support at the cost of another async hop on every message;
v1 has one transceiver, so it does not.

```
NEAR                                                        Hydration
────                                                        ─────────
zec.omft.near / wrap.near
  │ ft_transfer_call(ntt, amount, msg{73, to, false})
  ▼
ntt-<token> (LOCKING)                                        NttManager (BURNING)
  ft_on_transfer                                               ▲
    trim, rate limit, lock                                     │ mint → to
    publish_message ──► contract.wormhole_crypto.near          │
                          → guardians → relayer (ntt) ──► WormholeTransceiver.receiveMessage
  ▲
  │ complete(vaa, account_id)                     transfer(amount, 15, sha256(account)) ─┐
  │   verify_vaa → callback                                                              │
  │   peer + replay + rate limit                  WormholeTransceiver → core ────────────┘
  │   storage_deposit → ft_transfer → account          → guardians → relayer / user
```

## Addressing

Everything on the wire is `bytes32`. NEAR accounts are strings of up to 64 characters, so every
NEAR address is its **`sha256(account_id)`** — the same digest Wormhole on NEAR already uses for
emitters.

| Field                                  | NEAR → Hydration                   | Hydration → NEAR                         |
| -------------------------------------- | ---------------------------------- | ---------------------------------------- |
| VAA emitter                            | `sha256(ntt account)` (core-set)   | Hydration transceiver                    |
| `sourceNttManagerAddress`              | `sha256(ntt account)`              | Hydration manager, padded                |
| `recipientNttManagerAddress`           | Hydration manager, padded          | `sha256(ntt account)`                    |
| `NttManagerMessage.sender`             | `sha256(sender account)`           | Hydration sender, padded                 |
| `NativeTokenTransfer.sourceToken`      | `sha256(token account)`            | Hydration token, padded                  |
| `NativeTokenTransfer.to`               | Hydration EVM address, padded      | **`sha256(recipient account)`**          |

**No account registry.** The Wormhole NEAR token bridge keeps a `hash → account` map that recipients
must pre-register into. This contract does not: `complete(vaa, account_id)` takes the account in
plaintext and requires `sha256(account_id) == to`. The hash binds the recipient, so nobody can
redirect a VAA by supplying a different account, and nobody has to register — the frontend hashes
the account when the user starts the transfer on Hydration.

## Wire format

Byte-for-byte the EVM structs in `TransceiverStructs.sol` — the Hydration side parses them unchanged.

```
TransceiverMessage            prefix 0x9945FF10
  bytes32 sourceNttManagerAddress
  bytes32 recipientNttManagerAddress
  u16     nttManagerPayloadLength
  bytes   nttManagerPayload           ── NttManagerMessage
  u16     transceiverPayloadLength    ── 0 (no instructions)

NttManagerMessage
  bytes32 id                          NEAR: big-endian u64 counter, left-padded
  bytes32 sender
  u16     payloadLength
  bytes   payload                     ── NativeTokenTransfer

NativeTokenTransfer           prefix 0x994E5454
  u8      numDecimals                 ┐ TrimmedAmount — decimals first on the wire,
  u64     amount                      ┘ the reverse of the Solidity type's field order
  bytes32 sourceToken
  bytes32 to
  u16     toChain
  (u16 additionalPayloadLength + bytes — omitted when empty)
```

Inbound replay key is the NTT digest, `keccak256(sourceChainId_be ‖ encodedNttManagerMessage)`, as
on EVM — not the VAA hash, so re-signed VAAs for the same message cannot double-execute.

**Golden vectors.** A forge script encodes a set of messages with the real `TransceiverStructs`
library; the Rust codec must round-trip every one byte-for-byte, and a NEAR-encoded message must
parse in a forge test. This is the whole of the cross-chain compatibility risk, and it is testable
offline.

## Flow

### Outbound — NEAR → Hydration

The user signs one transaction:

```
token.ft_transfer_call(
  receiver_id = ntt-<token>.<ours>.near,
  amount,
  msg = {"recipient_chain": 73, "recipient": "0x<H160>", "should_queue": false}
)
```

`ft_on_transfer(sender_id, amount, msg)`:

1. Require `predecessor == config.token` — a call from any other token is refunded in full.
2. Parse `msg`; require a peer for `recipient_chain`.
3. **Trim.** `trimmed = trim(amount, min(8, token_decimals, peer_decimals))`; the dust is returned
   as part of the unused amount, so NEP-141 refunds it to the sender automatically. No dust
   revert, no dust kept.
4. **Rate limit.** Outbound capacity must cover `trimmed`. Breach with `should_queue = false` →
   return the full amount (refund). With `true` → queue the transfer for 24 h, as NTT does
   elsewhere. Consume outbound, backflow the peer's inbound.
5. Build the message; `seq += 1` for `id`.
6. `publish_message(hex(message), nonce)` on core, then `.then(on_published(sender, amount, ...))`.
7. `on_published`: success → return `0` unused (tokens stay locked). Failure → restore the rate
   limit and return the full amount unused, so the token refunds it.

Lock and publish are two receipts, but the refund path makes them fail-closed: **either a message
is published or the tokens go back.** There is no state where tokens are locked with no message.

`ft_on_transfer` cannot receive a NEAR deposit, so the core `message_fee` (if non-zero) is paid from
the contract's own balance. Gas: the caller attaches enough for `ft_on_transfer` + the publish (core
requires ≥ 10 TGas prepaid) + the callback; the frontend fixes it at a measured value.

### Inbound — Hydration → NEAR

Standard NTT `transfer(amount, 15, sha256(recipient_account))` on Hydration. Then anyone calls, on
NEAR:

```
complete(vaa, account_id)            attached deposit covers storage
```

1. Cross-contract `verify_vaa(vaa)` on core → `.then(on_verified(...))`. Core verifies signatures
   and the guardian set; it does not parse the body.
2. `on_verified`: parse the body locally (the token bridge's `byte_utils` are the reference);
   require emitter chain `73` and emitter `== transceiver_peer[73]`; parse `TransceiverMessage`;
   require `source == manager_peer[73]` and `recipient == sha256(self)`; parse the transfer; require
   `toChain == 15` and `sha256(account_id) == to`.
3. **Replay.** Require the digest unexecuted; mark it executed. Storage paid from the deposit.
4. **Rate limit.** Inbound capacity for chain 73 must cover it — otherwise queue it in
   `inbound_queue[digest]` for 24 h (released by a later `release_inbound(digest, account_id)`).
   Consume inbound, backflow outbound.
5. Untrim to token decimals (ZEC ×1, NEAR ×10¹⁶).
6. `token.storage_deposit(account_id, registration_only = true)` if the account is not registered,
   then `ft_transfer(account_id, amount)` (1 yocto), `.then(on_unlocked(...))`.
7. `on_unlocked`: failure → credit `claimable[account_id] += amount`. `claim()` pays it out later.

The VAA is consumed in step 3 and the tokens leave in step 6 — different receipts, and a receipt
cannot undo its predecessor. The **claimable fallback** is what makes that safe: a failed
`ft_transfer` never loses funds, it parks them against the account the VAA named. This is the part
of the contract most worth testing.

## Hub

**One LOCKING hub per Hydration token.** NTT assumes hub-and-spoke: burns on Hydration are backed by
custody on exactly one chain. If the same Hydration ZEC were also fed by the Solana corridor
(LOCKING Omni-ZEC on Solana), a burn could unlock from whichever custody answered, and one side
would drain against the other's backing.

So per token, it is this spec **or** the fallback, never both. Moving later from the fallback to
this contract means a new Hydration token or a drained, unpeered Solana custody first — not an
extra `setPeer`.

## Storage and admin

| State                                 | Purpose                                           |
| ------------------------------------- | ------------------------------------------------- |
| `config.token`, `token_decimals`      | the NEP-141 this contract locks                   |
| `config.core`                         | `contract.wormhole_crypto.near`                   |
| `manager_peer[chain]`, `peer_decimals[chain]` | NTT manager peers                         |
| `transceiver_peer[chain]`             | Wormhole emitter peers                            |
| `outbound_limit`, `inbound_limit[chain]` | NTT rate limits, 24 h linear refill            |
| `outbound_queue`, `inbound_queue`     | delayed transfers                                 |
| `executed[digest]`                    | replay protection                                 |
| `claimable[account]`                  | failed unlocks                                    |
| `seq`                                 | `NttManagerMessage.id`                            |
| `owner`, `paused`                     | admin                                             |

`owner`-only: `set_peer`, `set_limits`, `pause` / `unpause`, `transfer_ownership`. No instruction
moves locked tokens except inbound completion and `claim`. No admin withdraw.

**Upgradeability is account keys, not a proxy.** A NEAR contract is redeployable by any full-access
key on its account. Prod end-state, matching the other corridors: ownership to the Hydration TC's
counterpart (a NEAR multisig), and **all full-access keys removed** from the contract account, which
makes the code immutable. Until then, whoever holds a full-access key holds the custody.

## Invariants

1. **Fail-closed outbound.** Tokens are locked iff a message was published; a failed publish
   refunds through `ft_on_transfer`'s unused amount.
2. **Bound recipient.** Inbound tokens only ever reach the account whose `sha256` the VAA names.
3. **No loss on failed unlock.** A consumed VAA whose `ft_transfer` fails credits `claimable`.
4. **Replay-safe.** One execution per NTT digest.
5. **Single hub.** Custody lives only on NEAR; Hydration only burns and mints.
6. **Conservation.** `locked == Hydration supply + outbound not yet minted + inbound not yet
   released + claimable`. The two middle terms are in-flight or queued messages. Alarm on drift.

## Tokens

| Token | NEAR            | Decimals | Trim   | Hydration side                  |
| ----- | --------------- | -------- | ------ | ------------------------------- |
| ZEC   | `zec.omft.near` | 8        | exact  | new asset, BURNING manager      |
| NEAR  | `wrap.near`     | 24       | 24 → 8 | new asset, BURNING manager      |

NEAR's 24 → 8 trim leaves dust up to 10¹⁶ yocto per transfer; it is refunded in step 3, never
locked. Each Hydration asset needs `EVMAccounts.set_ntt_minter(assetId, manager)` (pallet 93,
call 7) — referendum-class, and the one real calendar gate.

## Launch caps

The contract custodies every bridged ZEC and NEAR. If it ships before an external audit, it ships
small: outbound and inbound limits sized to a canary (e.g. a few thousand dollars per 24 h), `pause`
kept live, caps raised as volume and time prove it out. NTT's rate limits exist for exactly this.
An internal pass (`/solidity-audit` covers Solidity only — the Rust contract needs its own review)
before mainnet regardless.

## Relaying

- **NEAR → Hydration.** The existing `ntt` app gets one route per token: `sourceChain: near` (15),
  `sourceEmitter: sha256(ntt account)`. Hydration gas is ours, as on every NTT route.
- **Hydration → NEAR.** v1: **self-redeem** — the frontend submits `complete(vaa, account_id)` from
  the user's own NEAR account, which already needs NEAR for storage. A `near-ntt` relayer app
  (`near-api-js`, attaches gas + storage deposit) is v2, and then needs a fee — the intents
  ceiling/claim model would apply.

## Latency

| Leg                          | Estimate                                                      |
| ---------------------------- | ------------------------------------------------------------- |
| NEAR → VAA                   | NEAR finality (~2–3 s) + watcher (`last_final_block` from h+2) |
| Hydration → VAA              | Hydration finality — see the chain-73 finality note           |
| Redeem                       | 1 block / 1–2 NEAR blocks (3 receipts inbound)                |

Seconds to a minute end to end, unmeasured.

## Trust

| Layer           | Trusted party                                                                  | Applies to |
| --------------- | ------------------------------------------------------------------------------ | ---------- |
| Zcash connector | NEAR MPC custody of native ZEC + light client; DAO admin                       | ZEC only   |
| Token contracts | `zec.omft.near` / `wrap.near` admins — could pause or upgrade the token        | both       |
| Wormhole        | guardians (13/19)                                                              | both       |
| NTT contracts   | NEAR contract (full-access keys until removed) + Hydration manager owner (TC)  | both       |

Against the fallback, every Omni row is gone: no MPC signing on the transfer path, no trusted
relayer gate, no `5kx8…` admin with mint power.

## Testing

| Layer                   | Covers                                                                   | Tooling                         |
| ----------------------- | ------------------------------------------------------------------------ | ------------------------------- |
| Codec                   | golden vectors from `TransceiverStructs.sol`, both directions            | forge script + `cargo test`     |
| Unit                    | trim, rate limits + backflow, queues, replay, peers, pause               | `cargo test`                    |
| Async                   | publish failure → refund; `ft_transfer` failure → claimable; unregistered storage; out-of-gas mid-chain | `near-workspaces` sandbox |
| Core integration        | real Wormhole NEAR core wasm with a test guardian set signing VAAs       | `near-workspaces` + `wormhole/near/contracts/wormhole` |
| Hydration side          | NEAR-emitted VAA into the real manager / transceiver / `set_ntt_minter`  | chopsticks, guardian set substituted — the Basejump probe pattern |
| Mainnet canary          | one small transfer each way under launch caps                            | —                               |

## Build notes

- **Workspace.** `crates/near/` as its own Cargo workspace beside `crates/solana`, contract
  `ntt-manager`; a `@whm/crates-near` package with `build` / `test` scripts.
- **References.** `wormhole/near/contracts/token-bridge` for `verify_vaa` → callback, VAA body
  parsing (`byte_utils.rs`) and deposit accounting — Apache-2.0. Omni's NEAR contracts for
  `ft_on_transfer` / storage handling on these exact tokens — MIT, so code can be reused with
  attribution.
- **Emitter.** Register the contract with `register_emitter` (payable, permissionless) before the
  first publish, or `publish_message` panics `EmitterNotRegistered`.
- **Migration.** A `near-ntt` definition deploying both ends. `WalletContext` gains a `near` wallet —
  `@whm/common` has no NEAR wallet yet. Steps: deploy + init NEAR contract → register emitter →
  deploy Hydration manager + transceiver → peers both ways → limits → ownership, with
  `set_ntt_minter` as governance between them. The NTT CLI does not know NEAR, so peers are migration
  steps, not `ntt push`.

## To verify

Checked before implementation — results and evidence in [verify.md](verify.md): `message_fee` is 0,
the Governor does not apply, both tokens need a 0.00125 NEAR registration, and the NEAR core is on
guardian set 7. Still open:

1. Guardians sign an emitter other than the token bridge on NEAR — yes by source, no live precedent.
   A plain-account `publish_message` settles it ([verify.md §3](verify.md#3-guardians-sign-a-non-portal-emitter--yes-by-source-unproven-live)).
2. Gas profile of both flows against the 300 TGas cap — sandbox, during implementation.
3. Whether Wormhole ever answers — a canonical NEAR NTT would be worth adopting over ours.
