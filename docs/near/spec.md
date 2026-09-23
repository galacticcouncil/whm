# NEAR → Hydration

## Abstract

Hydration wants ZEC and NEAR. Both live on NEAR as NEP-141 tokens (`zec.omft.near`, `wrap.near`),
and no NTT harness exists for NEAR — none public, at least. Rather than write one, this corridor
chains two bridges that already exist, through the one intermediate chain that makes them fast:

**NEAR → Omni Bridge → Solana → NTT → Hydration.**

Solana is the pivot because Wormhole guardians sign a Solana message at `finalized` commitment
(~13 s), where Ethereum and Base wait for L1 finality (~15–20 min). The Hydration half already
exists: the relayer's `ntt` app delivers Solana-sourced NTT routes today (SOL, jitoSOL, PRIME), and
both tokens already have Omni-deployed SPL mints on Solana.

The user signs **one** transaction, on NEAR, and pays for every leg after it in the token they
bridge. Everything after is cranked.

## Scope

- Inbound only: NEAR → Hydration. The return path is sketched in [Return path](#return-path-phase-2),
  not specified.
- Tokens: ZEC and NEAR. Any other NEP-141 with an Omni-deployed SPL mint is a route config away.
- Out of scope: native Zcash. Wormhole does not observe Zcash; this corridor starts from
  `zec.omft.near` on NEAR.

Diagrams and account layouts: [schema.md](schema.md).

## Options considered

| Route                                                                    | Hops | Latency      | Build        | Verdict                                          |
| ------------------------------------------------------------------------ | ---- | ------------ | ------------ | ------------------------------------------------ |
| NTT on NEAR (own Rust manager + transceiver, standard wire format)       | 1    | ~1 min       | High + audit | Long-term end state — drops the Omni trust layer |
| NTT-lite (lock + Wormhole message on NEAR, custom receiver on Hydration) | 1    | ~1 min       | Medium       | Non-standard; the return leg rebuilds NTT anyway |
| Omni → Ethereum/Base → NTT                                               | 2    | ~15–20 min   | Low          | Works, but pays L1 finality                      |
| **Omni → Solana → NTT**                                                  | 2    | **~1–3 min** | Low–medium   | **This spec**                                    |
| Legacy Portal + Moonbeam MRL                                             | 3    | slow         | Medium       | Reintroduces the leg intents dropped             |
| 1Click → WETH → NTT                                                      | 2    | minutes      | ~none        | Delivers value, not the token                    |
| PoA/HOT bridge delivers to Hydration                                     | 1    | —            | BD           | Worth pursuing in parallel                       |

NEAR itself is live on Wormhole (chain 15, core `contract.wormhole_crypto.near`, guardian set 7
signing today, governor $100k/day), but `native-token-transfers` ships only `evm`, `solana`, `sui`
and `xrpl` — no NEAR, and nothing announced. Worth asking Wormhole directly whether a non-public one
exists; if one is shareable, it replaces this corridor. The legacy Portal route is effectively dead
for these tokens: Portal-wrapped NEAR on Solana has ~57 supply, and `zec.omft.near` was never
attested.

## Architecture

| Component                                                                 | Chain     | Role                                                         | Status                            |
| ------------------------------------------------------------------------- | --------- | ------------------------------------------------------------ | --------------------------------- |
| `omni.bridge.near`                                                        | NEAR      | Locks the NEP-141, MPC-signs the transfer                    | existing (third party)            |
| Omni `bridge_token_factory` `dahPEoZGXfyV58JqqH85okdHmpN8U2q8owgPUXSCPxe` | Solana    | Verifies the MPC signature, mints the bridged SPL            | existing (third party)            |
| `near-forwarder`                                                          | Solana    | Deposit PDA per Hydration recipient; `forward` CPIs into NTT | **new** (Anchor, `crates/solana`) |
| NTT manager (baked-in transceiver)                                        | Solana    | LOCKING, one program per token, v3.0.0                       | **new deploy**, standard          |
| NTT manager + transceiver                                                 | Hydration | BURNING, per token                                           | **new deploy**, standard          |
| relay-fee quoter                                                          | off-chain | Quotes `max_relay_fee` per mint                              | extend `agents/intent`            |
| `near` app                                                                | relayer   | Watches deposit PDAs, cranks `forward`                       | **new**                           |
| `ntt` app                                                                 | relayer   | Delivers the NTT VAA to Hydration                            | existing — add routes             |
| Fee multisig                                                              | Solana    | Receives relay fees; swaps to SOL, tops up the crank         | **new** (Squads)                  |

The Solana NTT runs in **LOCKING** mode: Omni's `authority` PDA holds the SPL mint authority, so NTT
cannot burn or mint there. Hydration burns and mints — the same shape as the live SOL / jitoSOL /
PRIME routes (Solana v3.0.0 LOCKING, Hydration v2.0.0 BURNING).

## Flow

### 0. Frontend — quote and derive

1. Fetch `max_relay_fee` for the mint from the quoter ([Relay fee](#relay-fee)).
2. Derive `deposit = PDA(["deposit", mint, recipient, max_relay_fee])` ([Deposit address](#deposit-address)).
3. Register `(mint, recipient, max_relay_fee, deposit)` with the `near` app.

### 1. NEAR — the only user signature

`ft_transfer_call` on the token (`zec.omft.near` / `wrap.near`), `receiver_id = omni.bridge.near`:

```json
{
  "InitTransfer": {
    "recipient": "sol:<deposit PDA>",
    "fee": "<U128>",
    "native_token_fee": "0",
    "msg": null
  }
}
```

- **`recipient` is the owner, not a token account.** Omni's `finalize_transfer` mints to
  `ATA(mint, recipient)` and creates it (`init_if_needed`).
- **Pay the Omni fee in the token (`fee`), not `native_token_fee`.** A native fee needs a prior
  `storage_deposit` on `omni.bridge.near` — a second transaction, which breaks the one-signature
  promise. `fee` is deducted from the amount.
- **Never set `msg`.** Omni's Solana leg has no message field. A non-empty hex `msg` makes NEAR sign
  the V2 payload while the Solana program always verifies V1, so the transfer can never finalize.
  (Inferred from source; the frontend must not expose the field regardless.)

### 2. Omni — NEAR → Solana

A trusted relayer calls `sign_transfer`; the MPC network signs a secp256k1 payload; anyone submits
`finalize_transfer` on Solana, which checks the signature against
`config.derived_near_bridge_address`, marks the nonce used, mints to the deposit ATA, and posts a
`FinTransfer` Wormhole message back to NEAR so the Omni relayer can claim its fee.

### 3. Solana — `forward(recipient, max_relay_fee, fee_requested)`

Permissionless. The crank passes the seed inputs and the fee it claims; the program:

1. Derives `deposit = PDA(["deposit", mint, recipient, max_relay_fee])` and requires it to match the
   passed account. The recipient and the fee ceiling are part of the address, so **funds can only go
   where the seed says, at no more than the seed allows**.
2. Requires `fee_requested ≤ max_relay_fee`.
3. Reads the deposit ATA balance and quantizes it down to `10^(decimals − min(8, decimals,
   peer_decimals))`. NTT on Solana strips dust silently rather than reverting, but the session
   authority is keyed on the exact args — so the forwarder must pass a dust-free amount it also
   approves. Dust stays in the ATA for the next forward.
4. Requires `amount − fee_requested > 0`, else `AmountTooSmall`.
5. Transfers `fee_requested` to `ATA(mint, config.fee_recipient)` — the fee multisig, never the
   crank.
6. `spl_token::approve` the NTT session authority
   `PDA(["session_authority", deposit, keccak(args)], ntt)` for the net amount, signed by the
   deposit PDA.
7. CPI `transfer_lock({amount, 73, pad32(recipient), should_queue: false})`. The `outbox_item` is a
   fresh signer — a crank-generated keypair (what the NTT SDK does) or a forwarder PDA.
8. CPI `release_wormhole_outbound({revert_on_delay: true})` — posts the NTT message at `Finalized`
   in the same transaction. On Solana `transfer_lock` only writes the outbox item; the message
   exists once a transceiver releases it, queued or not.

`should_queue = false` means a rate-limit breach reverts the whole `forward` with
`TransferExceedsRateLimit` (`should_queue = true` would delay a full 24 h). The funds stay in the
deposit PDA and the crank retries. **Nothing is ever consumed without being sent.**

The NTT sender recorded in the outbox item is the deposit PDA.

### 4. Hydration — existing `ntt` app

Guardians sign after Solana finality; the `ntt` app submits the VAA to the Hydration transceiver;
the BURNING manager mints to the recipient. No Hydration code changes.

## Deposit address

```
deposit     = findProgramAddress(["deposit", mint, recipient, max_relay_fee_le], near_forwarder)
deposit_ata = getAssociatedTokenAddress(mint, deposit, allowOwnerOffCurve = true)
```

- `recipient` — the Hydration EVM address (H160) left-padded to 32 bytes, the same recipient
  encoding the live Solana NTT routes use.
- `max_relay_fee` — the user's fee ceiling in mint units, `u64` little-endian. It has no other way
  to reach Solana: Omni carries no message there. The address stands in for the signed instruction
  the intents corridor uses — change the ceiling and you get a different account, so it cannot be
  tampered with.
- `mint` — so one recipient's ZEC and NEAR deposits never share an account.

The frontend derives `deposit` off-chain and passes it to Omni as `sol:<deposit>`. Deriving it needs
no transaction: an address that has never been used is still valid.

## Who pays

The user pays for every leg on Solana, in the token they bridge. Nothing is subsidised.

| Leg                                                      | Paid by              | How                                                                     |
| -------------------------------------------------------- | -------------------- | ----------------------------------------------------------------------- |
| Omni NEAR → Solana (MPC signing, finalize, ATA rent)     | user                 | Omni `fee`, in the token, deducted on NEAR                              |
| `forward` on Solana (NTT outbox item, message, sig fees) | user                 | `fee_requested ≤ max_relay_fee`, in the token, deducted from the deposit |
| SOL for the `forward` tx itself                          | crank, as a float    | Fronted as `payer`; the fee settles in the same transaction             |

The crank key holds only a SOL float. Fees accumulate at `config.fee_recipient`, a multisig, which
swaps them to SOL and tops the crank back up on its own schedule. A leaked crank key costs the
float, not the collected fees. A third party cranking `forward` pays SOL and earns nothing — only
our relayer is expected to, and a user self-cranking after an outage is paying to move their own
funds.

For scale: 1 SOL of float covers ~575 forwards.

## Relay fee

The intents model ([relay-fee.md](../intents/relay-fee.md)), moved to Solana: a **ceiling** the user
authorizes up front, and a **claim** the relayer measures at forward time, bounded by it.

```
cost_sol       = 0.001738 SOL                  NTT transfer, measured on a live SOL → Hydration transfer
               + 5_000 lamports × signatures   crank + outbox_item keypair
               + priority fee                  if set

max_relay_fee  = cost_sol × price(SOL / token) × (1 + marginBps)      quoter, at deposit time
fee_requested  = cost_sol × price(SOL / token)                        relayer, at forward time
relay iff        fee_requested ≤ max_relay_fee
```

- **The cost barely moves; the price does.** A forward *is* an NTT transfer — the approve and fee
  transfer around it add no accounts — so `cost_sol` is close to a constant. The uncertainty the
  margin absorbs is SOL priced in ZEC or NEAR between quote and forward, which Omni's latency
  (~30 s – minutes) keeps short.
- **The quoter** extends `agents/intent`'s relay-fee endpoint with a per-mint entry and a
  SOL/token price feed. The caller owns the margin, as in intents.
- **The floor is relayer self-interest.** The contract cannot see SOL prices; it only enforces the
  ceiling. A deposit whose ceiling no longer covers cost is simply not relayed.
- **A too-low ceiling is a liveness problem, never a loss** — but unlike intents it does not heal by
  waiting for gas to fall. It clears only if SOL/token moves back, or if the operator forwards at a
  loss. The user cannot raise it: the ceiling is in the seed, and a new ceiling is a new address. Size
  the margin for that. (A ceiling in basis points of the amount would let a top-up fix it; rejected
  for now to keep the intents semantics.)

## Storage and admin

| Account  | Seeds             | Fields                                 |
| -------- | ----------------- | -------------------------------------- |
| `Config` | `["config"]`      | `owner`, `fee_recipient`, `paused`     |
| `Route`  | `["route", mint]` | `ntt_program`, `enabled`               |

`set_enabled`, `set_paused` and `set_fee_recipient` are `owner`-only. The owner has **no power over
what a user pays** — the ceiling is the user's, in the seed, and the claim is the relayer's, bounded
by it. The prod end-state renounces `owner` like every other corridor; a renounced forwarder can
neither be paused nor have its fee recipient rotated, so decide explicitly whether those survive the
migration.

No instruction moves funds anywhere except through `forward`. There is no admin withdraw.

## Invariants

1. **Seed binding.** A deposit PDA only ever releases to the recipient in its seed, on chain 73.
2. **Fail-closed forward.** Fee transfer, approve, `transfer_lock`, and release are one transaction:
   a rate-limit breach, paused NTT, or disabled route reverts all of it and leaves the balance in
   place.
3. **User-bounded fee.** `fee_requested ≤ max_relay_fee`, and `max_relay_fee` is in the seed — no
   owner or relayer can raise it.
4. **Fees to the multisig.** `fee_requested` only ever goes to `config.fee_recipient`.
5. **Permissionless from Solana onward.** Anyone can crank `forward`; if our relayer stops, the
   user (or anyone) can forward their own deposit. The NEAR → Solana leg is **not** permissionless:
   `sign_transfer` is gated to Omni's staked trusted relayers.
6. **No custody drift.** The forwarder holds no pooled balance — every token sits in a
   per-deposit ATA until forwarded.

## Tokens

| Token | NEAR            | Solana mint (Omni)                             | Decimals NEAR → Solana | NTT trim                  |
| ----- | --------------- | ---------------------------------------------- | ---------------------- | ------------------------- |
| ZEC   | `zec.omft.near` | `A7bdiYdS5GjqGFtxf17ppRHtDKPkkRqbKtR27dxvQXaS` | 8 → 8                  | exact                     |
| NEAR  | `wrap.near`     | `3ZLekZYq2qkZiSpnSvabjit34tUkjSwD1JFuW9as9wBG` | 24 → 9                 | 9 → 8, dust `amount % 10` |

Both mints are legacy SPL Token, mint authority = Omni `authority` PDA `FvULawNP…NYds`, no freeze
authority. Omni caps Solana decimals at 9 and floors on NEAR; the 24 → 9 dust goes to the Omni fee.
Supplies at 2026-09-23: ~101,076 Omni ZEC and ~1.84M Omni NEAR on Solana.

`zec.omft.near` began as a NEAR Intents PoA token and has **migrated to Omni Bridge**:
`zcash-connector.bridge.near` mints it against native ZEC verified by a Zcash light client
(`zcash-client.bridge.near`), and withdrawals are signed by the NEAR MPC signer `v1.signer`, which
custodies the ZEC. Supply ~148,733 ZEC, of which ~101,706 is locked in `omni.bridge.near`. Omni ZEC
also exists on Ethereum (`0x8497…7f18`), Base and Arbitrum.

Standing up each token is the usual per-token NTT deploy — Solana LOCKING manager, Hydration BURNING
manager, bilateral `setPeer` — plus a Hydration runtime call
`EVMAccounts.set_ntt_minter(assetId, manager)` (pallet 93, call 7), which is referendum-class. Size
the Solana outbound limit per token; the live Solana routes run 2,595.84 SOL / jitoSOL and
449,016.98 PRIME per 24 h.

## Trust

| Layer               | Trusted party                                                                                                                          | Applies to |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| Zcash connector     | NEAR MPC custody of native ZEC + Zcash light client; admin `rainbowbridge.sputnik-dao.near`, sole relayer `omni-relayer.bridge.near`   | ZEC only   |
| Omni, NEAR → Solana | NEAR MPC network (chain signatures) + Omni trusted relayers (liveness)                                                                 | both       |
| Omni, Solana admin  | `5kx8AapW…eb6` — upgrade authority on the program **and** able to replace the MPC key `finalize_transfer` trusts, i.e. full mint power | both       |
| Omni, NEAR admin    | DAO via near-plugins ACL — staged upgrades, provers, `transfer_token_as_dao`                                                           | both       |
| NTT                 | Wormhole guardians (13/19) + manager owners                                                                                            | both       |
| Forwarder           | `near-forwarder` code; owner until renounced                                                                                           | both       |

The Omni Solana admin is the heaviest single trust point: whoever holds `5kx8…` can mint unbacked ZEC
and NEAR on Solana, and those would bridge to Hydration as real. The Hydration inbound NTT limit is
the backstop. Omni has no time-based rate limit of its own. A NEAR-native NTT would remove every Omni
row.

## Latency

| Leg                           | Estimate                                   |
| ----------------------------- | ------------------------------------------ |
| NEAR finality + MPC signature | ~30 s (Omni README) — SDK docs say 1–5 min |
| Omni finalize on Solana       | seconds, relayer-dependent                 |
| `forward`                     | ~1 slot after the crank sees the deposit   |
| Solana `finalized` → VAA      | ~15–25 s                                   |
| Hydration redeem              | 1 block                                    |
| **Total**                     | **~1–3 min** (unmeasured)                  |

## Relaying

- **`near` app (new)** in `agents/relayer`. Watches the Omni program's finalize logs on Solana (or
  `FinTransfer` messages), filters mints to deposit ATAs whose owner is a forwarder PDA, prices
  `fee_requested`, and sends `forward` if it fits under the ceiling. It needs
  `(recipient, max_relay_fee)` to derive and sign for the PDA, and Omni cannot carry them — Solana
  has no message field. Two ways to get them:
  - **Registration endpoint.** The frontend posts `(mint, recipient, max_relay_fee, deposit)` when it
    derives the address; the app re-derives the PDA before trusting it.
  - **`external_id`.** Put both in the NEAR `InitTransfer` (≤ 64 bytes: 20-byte H160 + 8-byte
    ceiling, hex) and read them from the NEAR transfer event. Unconfirmed that `external_id` is
    emitted.

  Retries while the ceiling covers cost: every failure except a bad recipient is transient
  (invariant 2). A deposit whose ceiling no longer covers cost is parked, not dropped.

- **`ntt` app (existing)** gets one route per token: `sourceChain: solana`, `sourceEmitter` = the
  Solana NTT program id.

## Return path (phase 2)

The same design in reverse. NTT from Hydration unlocks on Solana into
`PDA(["return", mint, sha256(near_account)])`; a crank CPIs Omni's Solana `init_transfer` to
`near:<account>`. Omni requires `user` to be a signer owned by the system program — a data-less
PDA signing via `invoke_signed` satisfies that. NEAR verifies the transfer through its Wormhole VAA
prover (~1.5–2 min); `fin_transfer` on NEAR is again gated to trusted relayers. Unlike NEAR →
Solana, a Solana → NEAR transfer **does** carry a message, which NEAR turns into `ft_transfer_call`
to the recipient. Users never need a Solana wallet in either direction.

## Failure modes

| Case                                                     | Outcome                                                                                         |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| NTT outbound limit hit                                   | `forward` reverts; funds wait in the PDA; crank retries                                         |
| Hydration inbound limit hit                              | VAA delivered but queued on Hydration; released after the window (same as other NTT routes)     |
| Omni paused (`INIT_TRANSFER` / `FINALIZE_TRANSFER` bits) | Tokens locked on NEAR, not yet minted; resumes on unpause (admin only)                          |
| Omni relayers down                                       | NEAR → Solana stalls; we cannot self-relay `sign_transfer` without staking as a trusted relayer |
| `msg` set on the NEAR transfer                           | Stuck — Solana signature verification fails                                                     |
| Ceiling below cost at forward time                       | Not relayed; parked until SOL/token moves back or the operator forwards at a loss               |
| Crank down                                               | Deposits accumulate; anyone can `forward` (invariant 5)                                         |
| Wrong Hydration address                                  | Irreversible — the seed is the recipient. The frontend must validate                            |
| Deposit below `fee_requested` + trim unit                | `forward` reverts `AmountTooSmall`; tops up on the next deposit                                 |

## Build notes

- **Hand-build the NTT CPIs.** NTT is Anchor 0.29, `crates/solana` is 0.32 — don't take the NTT
  crate's `cpi` feature. Discriminators are `sha256("global:transfer_lock")[..8]` and
  `sha256("global:release_wormhole_outbound")[..8]`, args Borsh. The NTT program id is per token, so
  it comes from `Route`, not a constant.
- **Transaction size.** fee transfer + approve + `transfer_lock` + release is ~27 accounts; expect a
  v0 tx with a lookup table (NTT ships `initialize_lut`). Fallback: split release into a second tx —
  it is permissionless and a repeat fails `MessageAlreadySent`.
- **Account lists** for `transfer_lock` and `release_wormhole_outbound` are in
  [schema.md](schema.md#forward--cpi-sequence).

## To verify

1. Off-curve PDA recipient through Omni `finalize_transfer` on mainnet (source says yes; untested).
2. A forwarder-PDA `outbox_item` signing through `invoke_signed` against NTT (standard Solana,
   untested) — otherwise the crank co-signs with a keypair.
3. The stuck-`msg` hazard (inferred from source).
4. Deployed `omni.bridge.near` and the Solana program match `master`; trusted-relayer gating live on
   mainnet.
5. Who holds `5kx8…` and its threshold.
6. Measured NEAR → Solana latency and Omni fee levels (fee API:
   `mainnet.api.bridge.nearone.org/api/v1`).
7. Whether `external_id` is emitted in the NEAR transfer event.
8. A SOL/ZEC and SOL/NEAR price source for the quoter and the relayer.
9. Whether Wormhole has a non-public NEAR NTT — the public repo has none; if one exists, reassess
   the whole corridor.
