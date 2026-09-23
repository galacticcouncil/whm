# NEAR → Hydration Schema

Data flow, account layouts, and the `forward` CPI sequence. Design rationale lives in
[spec.md](spec.md).

## NEAR → Solana → Hydration

One user signature on NEAR; two cranks after it.

```
A: NEAR (source)             Omni (off-chain)         B: Solana (pivot)                     Relay            C: Hydration (dest)
┌────────────────────────┐   ┌──────────────┐        ┌─────────────────────────────────┐   ┌───────────┐    ┌────────────────────────┐
│ frontend               │   │              │        │                                 │   │           │    │                        │
│ 0. quote max_relay_fee │   │              │        │                                 │   │           │    │                        │
│    derive deposit PDA  │   │              │        │                                 │   │           │    │                        │
│    register ───────────┼───┼──────────────┼────────┼─────────────────────────────────┼──→│ near app  │    │                        │
│                        │   │ trusted      │        │ Omni dahPEoZG…CPxe              │   │           │    │                        │
│ user                   │   │ relayer:     │        │ 3. finalize_transfer            │   │           │    │                        │
│ 1. ft_transfer_call    │   │ 2. sign_     │───────→│    verify MPC secp256k1 sig     │   │           │    │                        │
│    token →             │──→│    transfer  │        │    mint SPL → ATA(deposit PDA)  │   │           │    │                        │
│    omni.bridge.near    │   │    MPC signs │        │    (init_if_needed)             │   │           │    │                        │
│    recipient =         │   │              │        │                │                │   │           │    │                        │
│    sol:<deposit PDA>   │   │              │        │                ▼                │   │           │    │                        │
│    fee in token        │   │              │        │ near-forwarder                  │   │           │    │                        │
│    msg = null  (!)     │   │              │        │ 4. forward(recipient,           │   │           │    │                        │
│                        │   │              │        │      max_relay_fee,  ◄──────────┼───│ (crank,   │    │                        │
│ (one signature)        │   │              │        │      fee_requested)             │   │  SOL      │    │                        │
└────────────────────────┘   └──────────────┘        │    seed check                   │   │  payer)   │    │                        │
                                                     │    fee_requested ≤ ceiling      │   │           │    │                        │
                                                     │    quantize to trim unit        │   │           │    │                        │
                                                     │    fee → fee multisig           │   │           │    │                        │
                                                     │    approve session authority    │   │           │    │                        │
                                                     │    CPI transfer_lock            │   │           │    │                        │
                                                     │    CPI release_wormhole_outbound│   │           │    │                        │
                                                     │                │                │   │           │    │                        │
                                                     │ NTT (LOCKING)  ▼                │   │           │    │ NTT (BURNING)          │
                                                     │ custody ← amount                │   │ 5. VAA    │    │ 6. transceiver         │
                                                     │ Wormhole msg, Finalized ~15-25s─┼──→│ ntt app  ─┼───→│    receiveMessage      │
                                                     └─────────────────────────────────┘   └───────────┘    │    mint → recipient    │
                                                                                                            └────────────────────────┘
```

`(!)` A non-empty hex `msg` makes NEAR sign Omni's V2 payload; the Solana program only verifies V1,
so the transfer can never finalize. The frontend must never set it.

## Fee flow

```
user (NEAR)                          Solana                                         off-chain
───────────                          ──────                                         ─────────
quote ◄───────────────────────────────────────────────────────────────────────────── quoter (agents/intent)
  max_relay_fee = cost_sol × price(SOL/token) × (1 + marginBps)
  │
  └─ committed into the deposit seed
                                     forward:
                                       crank pays cost_sol (float)  ◄── SOL top-up ── fee multisig
                                       fee_requested ≤ max_relay_fee                     ▲
                                         deposit_ata ── fee_requested ──────────────────►┘ swaps token → SOL
                                         deposit_ata ── amount − fee ──► NTT custody
```

The crank fronts SOL and is never reimbursed directly: the fee goes to the multisig, which refills
the crank. `cost_sol` = 0.001738 SOL (measured NTT transfer) + signature fees + priority fee.

## `forward` — atomicity

```
   forward(recipient, max_relay_fee, fee_requested)
        │
        ├─ config.paused? ───────────────── yes ─► revert
        ├─ route[mint].enabled? ─────────── no ──► revert
        ├─ deposit == PDA(seeds)? ───────── no ──► revert
        ├─ fee_requested ≤ max_relay_fee? ─ no ──► revert FeeAboveCeiling
        │
        ├─ amount = floor(balance, trimUnit) − fee_requested
        │     amount ≤ 0 ─────────────────────── ► revert AmountTooSmall
        │
        ├─ token::transfer  deposit_ata → ATA(fee_recipient)  (fee)   signer: deposit PDA
        ├─ token::approve   session_authority, amount                 signer: deposit PDA
        ├─ ntt::transfer_lock(amount, 73, pad32(recipient), false)    signer: payer, outbox_item
        │     rate limit breached ─────────────── ► TransferExceedsRateLimit, whole tx reverts
        └─ ntt::release_wormhole_outbound(revert_on_delay = true)
              → Wormhole message posted, Finality::Finalized
```

One Solana transaction, so the only two end states are "nothing happened" and "message posted".
There is no state where the deposit is debited and no message exists.

`trimUnit = 10^(decimals − min(8, decimals, peer_decimals))` — 1 for ZEC (8 dp), 10 for NEAR (9 dp).
NTT would strip the dust itself, but the session authority hashes the exact args, so the forwarder
approves and sends the already-trimmed amount. The fee is taken from the trimmed balance, so the
remaining `amount` is dust-free too.

## `forward` — CPI sequence

The NTT program id comes from `Route[mint].ntt_program`; every NTT PDA below is under it.

```
seeds = ["deposit", mint, recipient, max_relay_fee_le, bump]
args  = TransferArgs { amount, recipient_chain: 73, recipient_address: pad32(recipient), should_queue: false }
sa    = PDA(["session_authority", deposit, keccak(amount_be ‖ 73_be ‖ recipient_address ‖ 0x00)], ntt)

1. spl_token::transfer(deposit_ata → ATA(mint, config.fee_recipient), fee_requested)
     invoke_signed(seeds)

2. spl_token::approve(deposit_ata, delegate = sa, owner = deposit, amount)
     invoke_signed(seeds)

3. ntt::transfer_lock(args)                            disc = sha256("global:transfer_lock")[..8]
     payer              w  signer   crank
     config             r           ["config"]
     mint               w
     from               w           deposit_ata
     token_program
     outbox_item        w  signer   fresh — crank keypair, or forwarder PDA via invoke_signed
     outbox_rate_limit  w           ["outbox_rate_limit"]
     custody            w           config.custody
     system_program
     inbox_rate_limit   w           ["inbox_rate_limit", 73_be]
     peer               r           ["peer", 73_be]
     session_authority  r           sa

4. ntt::release_wormhole_outbound({ revert_on_delay: true })
                                     disc = sha256("global:release_wormhole_outbound")[..8]
     payer              w  signer   crank
     config             r
     outbox_item        w
     transceiver        r           ["registered_transceiver", ntt]
     wormhole_message   w           ["message", outbox_item]
     emitter                        ["emitter"]
     bridge / fee_collector / sequence   w   Wormhole core
     core program, system_program, clock, rent
```

Built by hand, not through the NTT crate's `cpi` feature — NTT is Anchor 0.29, `crates/solana` is
0.32. ~27 accounts: expect a v0 tx with a lookup table, or release in a second tx (permissionless;
a repeat fails `MessageAlreadySent`).

`transfer_lock` only writes the outbox item. The Wormhole message exists once step 4 releases it —
required for every transfer, not only queued ones.

## Deposit address derivation

```
recipient      : [u8; 32]   Hydration EVM address (H160), left-padded — same as live Solana NTT routes
max_relay_fee  : u64 (LE)   user's fee ceiling, mint units — from the quoter
mint           : Pubkey     Omni SPL mint — ZEC A7bdiYdS…XaS / NEAR 3ZLekZYq…wBG

deposit        = PDA(["deposit", mint, recipient, max_relay_fee_le], near_forwarder)
deposit_ata    = ATA(mint, owner = deposit)          // off-curve owner; Omni creates it

Omni recipient:  "sol:" + deposit                    // the owner, not the ATA
```

Derived off-chain, no transaction. The address carries the ceiling the way the intents instruction
VAA does — a different ceiling is a different account. The crank still needs
`(recipient, max_relay_fee)` to sign for the PDA, and Omni cannot carry them to Solana — it gets them
from the frontend registration or from the NEAR transfer's `external_id` (see
[spec.md](spec.md#relaying)).

## Accounts

```
Config  PDA ["config"]
┌──────────────────────────┐
│ owner         : Pubkey   │  renounced (Pubkey::default) at prod end-state
│ fee_recipient : Pubkey   │  fee multisig — fees land in ATA(mint, fee_recipient)
│ paused        : bool     │
│ bump          : u8       │
└──────────────────────────┘

Route   PDA ["route", mint]
┌──────────────────────────┐
│ mint          : Pubkey   │
│ ntt_program   : Pubkey   │  per-token NTT program instance
│ enabled       : bool     │
│ bump          : u8       │
└──────────────────────────┘

Deposit PDA ["deposit", mint, recipient, max_relay_fee]   no data — signer only
└─ ATA(mint)  holds the bridged SPL until forwarded
```

No fee lives in storage. The ceiling is the user's (in the seed), the claim is the relayer's (an
argument), and the owner can change neither.

## Wire format

No custom payload. `forward` emits a standard NTT `NativeTokenTransfer` through the manager's
baked-in Wormhole transceiver, so the Hydration side is an unmodified NTT deployment:

```
NativeTokenTransfer {
    TrimmedAmount amount;      // ≤ 8 decimals — net of fee_requested
    bytes32       sourceToken; // Solana mint
    bytes32       to;          // pad32(recipient) — Hydration EVM address
    uint16        toChain;     // 73
}
```

The NTT manager message's `sender` is the deposit PDA; its `id` is the `outbox_item` key.

## Component relationships

```
NEAR                          Solana                                         Hydration
────                          ──────                                         ─────────

zcash-connector.bridge.near
  └─ mints zec.omft.near ─┐
wrap.near ────────────────┼─ lock ─► omni.bridge.near
                          │            │ MPC (v1.signer)
                          ▼            ▼
                                Omni dahPEoZG…  ── authority PDA FvULaw… ──┐
                                admin 5kx8… (upgrade + MPC key)            ▼
                                                                     SPL mint (ZEC / NEAR)
                                                                           │
                                near-forwarder                             │
                                ├─ Config ── fee_recipient ──► fee multisig│
                                ├─ Route[mint] ── ntt_program ─────────────┼──► NttManager (LOCKING) ──peer──► NttManager (BURNING)
                                └─ Deposit PDAs ─ hold ATAs ───────────────┘     baked-in transceiver ────────► WormholeTransceiver
                                                                                                              │
                                                                                                              └─ set_ntt_minter(asset)
```

`near-forwarder` knows nothing about NEAR: it forwards whatever SPL lands in a deposit PDA, so
swapping Omni for another NEAR → Solana bridge needs no forwarder change.

## Return path (phase 2)

```
Hydration NTT (BURNING)                Solana                                   NEAR
  transfer(amount, 1, pad32(ret)) ──►  NTT (LOCKING) unlock → ATA(ret)
                                       ret = PDA(["return", mint, sha256(near_account)])
                                             data-less → system-owned signer
                                       crank: CPI Omni init_transfer ─────────► Wormhole VAA prover
                                              recipient = near:<account>          fin_transfer (trusted relayer)
                                              Finalized, ~1.5–2 min               → unlock NEP-141
```
