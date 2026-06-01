# Verifying the message-emitter program

This document lets anyone independently confirm that the bytecode deployed
on Solana mainnet at the program ID below was built from this repository.
No private keys or special access required — verification is read-only.

## Deployment

|                   |                                                |
| ----------------- | ---------------------------------------------- |
| Program ID        | `8j68bb2BLUSgEW6rdF3LnkxZFGieokLfJMBVd8bjATiz` |
| Cluster           | Solana mainnet                                 |
| Upgrade authority | `6db8TCH51fK4Pq2LkBdMaMFPfXD17GjfLD8TaMPWNuiq` |
| `Config.owner`    | `6db8TCH51fK4Pq2LkBdMaMFPfXD17GjfLD8TaMPWNuiq` |
| Repository        | https://github.com/galacticcouncil/whm         |
| Source path       | `platforms/solana/programs/message-emitter`    |

### Program-derived addresses

Derived deterministically from the program ID; no private keys exist for these.

| Seed                                    | Address                                        |
| --------------------------------------- | ---------------------------------------------- |
| `["emitter"]`                           | `67uc52guejA343y3D9bzwAcyY36AcoL8ZTuCdKDo6pJj` |
| `["config"]`                            | `FsfWPPq9xNEgmHcQgE4hZ4wwRLBpqmE29ePWJZZJ7zJY` |
| `["price_feed", PRIME_ASSET_ID]`        | `F91oB5TobNzjjcEYj3pVRiz33EzH2H9ibHyVcwa1B8Sc` |
| `["price_feed", SOL_ASSET_ID]`          | `38WQctAcvbivTAxGqCKBGZKrdNAVtoSK1BpyQy8YYBMt` |
| `["stake_pool_feed", JITOSOL_ASSET_ID]` | `AwpwmmFgkthkPogke5yqU9XtDk42JcN15Ejmo6qymVRG` |

## Toolchain used at deploy

To reproduce the deployed bytecode bit-for-bit, build with the same toolchain.

| Tool       | Version |
| ---------- | ------- |
| Solana CLI | 3.0.15  |
| Anchor     | 0.32.1  |

## How to verify

```bash
# 1. Hash of the deployed bytecode (read-only RPC call)
solana-verify get-program-hash 8j68bb2BLUSgEW6rdF3LnkxZFGieokLfJMBVd8bjATiz

# 2. Build from source
git clone https://github.com/galacticcouncil/whm
cd whm/platforms/solana
git checkout <commit-hash>      # the commit you want to verify against
anchor build -p message_emitter

# 3. Hash of the locally-built artifact
solana-verify get-executable-hash target/deploy/message_emitter.so

# 4. Compare. If the two hashes are identical, the deployed bytecode is
#    provably built from the source at <commit-hash>.
```

If `solana-verify` is not installed:

```bash
cargo install solana-verify
```

The hashes will only match if your local toolchain matches the one used at
deploy. Differences in `solana-cli`, `rustc`, or `LLVM` versions will produce
different bytecode even from identical source.

## What this proves

A successful verification proves:

- The deployed bytecode is the same bytes that this source compiles to.
- The `declare_id!()` in [programs/message-emitter/src/lib.rs](programs/message-emitter/src/lib.rs)
  matches the on-chain program ID.
- All PDAs above are derivable from the program ID and the seeds shown in
  source — no hidden state.

## What this does not prove

- That the upstream Solana toolchain itself is honest.
- That the dependencies (`anchor-lang`, the Wormhole shim) do what they
  claim. Their source can be inspected separately.
- Anything about the Wormhole guardian network, Kamino Scope, or SPL stake
  pool accounts that this program reads from at runtime — those are
  independent systems with their own trust assumptions.

## Immutability

The intent is to revoke the upgrade authority via
`solana program set-upgrade-authority --final` once the deployment is
considered stable. After that, the deployed bytecode is permanent and
cannot be changed by anyone, including the upgrade authority holder.

Current status is observable via:

```bash
solana program show 8j68bb2BLUSgEW6rdF3LnkxZFGieokLfJMBVd8bjATiz
```

If the `Authority` field is `none`, the program is final.
