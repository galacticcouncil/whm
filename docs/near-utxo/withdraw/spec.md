# SPEC — UTXO withdraw: Hydration → a UTXO chain through a derived NEAR account

How a Hydration user sends a UTXO coin — ZEC today, BTC next — back to an address on its own chain
with **one Hydration call**, no NEAR account and no third party. The call makes an NTT transfer that
lands the coin's NEAR token on an account `A` derived from the destination address, and publishes the
address on chain; a small NEAR contract signs, for `A`, the only thing `A` can do — withdraw through
Omni's connector for that chain to that address.

Interfaces, encodings and records: [schema.md](schema.md). Per chain: [zcash.md](zcash.md).

**[V]** verified in code, on chain or by a live call; **[I]** inferred.

## Why

Deposits are one transfer from the coin's own chain ([deposit](../deposit/spec.md)). The way back is
not: Hydration → NEAR NTT ([near-ntt spec § Inbound](../../near-ntt/spec.md#inbound--hydration--near))
pays a NEAR account, and the user ends up holding the coin's NEAR token there.

Omni's connectors already do the last leg: `ft_transfer_call(connector, Withdraw{…})` from whoever
holds the token. The missing piece is an account that holds it on the user's behalf and can only ever
send it to their address.

## Summary

- **Terms are the destination address.** `path = "<chain>:v1:" + address` → `A` via `v1.signer`,
  predecessor the chain's `UtxoWithdraw`. One address, one `A`, permanently — every later withdrawal
  to it reuses `A`.
- **On Hydration: one emitter per coin.** `send(amount, destination, nearAccount)` keeps a small fee
  in the coin, makes the NTT transfer of the rest to `sha256(A)` and emits `WithdrawRequested`, keyed
  on the NTT sequence — the same event for every coin. The NTT message carries only `sha256(A)`, which
  cannot be inverted; the event is how the bots learn what to do, from chain alone. Governance's
  `refuel` turns the fees into NEAR for the bots' gas.
- **On NEAR: `UtxoWithdraw`**, one deployment per chain, stateless, DAO-upgradeable like the NTT
  manager. Two methods, each signing one fixed NEAR meta-transaction for `A`.
- **Two bots** (no authority): `ntt-near` redeems the NTT VAA for `A`; the `utxo` relayer picks the
  connector coin to spend, calls `withdraw(address, coin)` and submits the signed result. Both pay the
  NEAR gas.
- **No refund.** Funds in `A` can only leave to the address in the terms; every failure puts them back
  in `A` for the next attempt.

## The flow

```text
USER (Hydration)
  <Coin>UtxoEmitter.send(amount, destination, nearAccount)        app derives nearAccount = A first (api)
    ├─ pull amount of the coin from the user
    ├─ keep fee (owner-set, in the coin)                           ← stays in the emitter
    ├─ require amount − fee ≥ the connector's minimum
    ├─ NttManager.transfer(amount − fee, 15, sha256(A))            burned on Hydration
    └─ emit WithdrawRequested(seq, A, sender, amount − fee, fee, destination)
                │
                ▼  Wormhole VAA (chain 73, the coin's transceiver, seq)
NTT-NEAR (agents/relayer) — only VAAs whose source tx has a WithdrawRequested (= fee paid)
  └─ ntt-<coin>.complete(vaa, A)                                    registers A, unlocks the token to A
UTXO RELAYER (agents/utxo) — one record per WithdrawRequested
  ├─ check   derive(destination) == A
  ├─ wait    balance(A) ≥ the connector's minimum
  ├─ create A (1 yocto, first time only)
  ├─ pick a coin (best fit, off-chain)
  ├─ withdraw-<coin>.withdraw(address, coin)                        MPC signs A's withdrawal
  └─ relay the signed delegate                                      any failure → next poll retries
                │
                ▼
OMNI (NEAR → the coin's chain)
  connector: burns, signs and broadcasts the transaction
  → address receives (amount − fee) − bridge fee − miner fee

FEE LOOP (TC, whenever it wants)
  <Coin>UtxoEmitter.refuel(coinIn, minNearOut, account)             owner = Hydration governance
    ├─ router sell coinIn of the held fee → NEAR                    slippage ≥ minNearOut
    └─ ntt-near transfer(NEAR, 15, sha256(account))                 account named per call
                │
                ▼  Wormhole VAA (chain 73, NEAR transceiver)
  by hand: ntt-near.complete(vaa, account)                          wNEAR to the bot's account
           wrap.near.near_withdraw(amount)                          → native NEAR: gas tank refilled
```

| Who                       | Does                                                                    | Pays                                                                                         |
| ------------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| App                       | validates the address, derives `A` (`agents/utxo` api)                  | —                                                                                            |
| User                      | `send` on the coin's emitter                                            | `fee` in the coin; Hydration gas; NTT delivery price to NEAR is 0 **[V]**                    |
| Emitter                   | pulls the coin, keeps `fee`, NTT transfer of the rest, emits the address | —                                                                                           |
| Bots                      | `complete`; create `A` once, `withdraw`, submit the delegate            | NEAR gas, `A`'s token storage (0.00125 NEAR once), 1 yocto per call — refilled from the fees |
| TC (Hydration governance) | sets `fee`; `refuel` turns the held fee into NEAR for the bots          | —                                                                                            |
| `UtxoWithdraw`            | derives `A`, builds and MPC-signs the delegate                          | —                                                                                            |
| Omni connector            | validates the withdrawal, signs the transaction through its own MPC, burns | bridge fee and miner fee, out of the amount                                               |

## Terms → `A`

`path = "<chain>:v1:" + address` → `A` under the chain's `UtxoWithdraw` — the derivation is in
[schema § 2](schema.md#2-terms--a); each chain's address format and golden vector are in its file.

- **Validated before anyone sends.** A malformed address is the one way to strand funds: the connector
  would reject every withdrawal and nothing else can move them. The app derives `A` only for an
  address that passes the same check the contract applies, and golden vectors pin
  `address → path → A` across the app and the contract.
- **A different path prefix is a different account.** `<chain>:v1` is frozen once the first user
  sends; a new address kind for the chain is a new prefix, with its own accounts.

`A` exists on NEAR only once something transfers NEAR to it: the runtime then creates it with a
full-access key equal to its id **[V nearcore `action_implicit_account_creation_transfer`]**, and it
needs no balance for storage — an account under 770 bytes is a zero-balance account **[V nearcore
`ZERO_BALANCE_ACCOUNT_STORAGE_LIMIT`]**. The relayer does this once per `A`; anyone can. The token
balance does not need it: `complete` registers `A` on the token (NEP-145, open) and pays out,
whether or not the account exists.

## Hydration — the coin's emitter

One emitter per coin (`ZecUtxoEmitter` today), each its own UUPS deployment owned by Hydration
governance; interface and events in [schema § 3](schema.md#3-the-emitter-hydration).

The NTT message names `sha256(A)` and nothing else: no payload, and a hash the bots cannot invert
back to `A`, let alone to the address. The address has to be on chain somewhere the bots read, in
the same user call. It is only a **hint**, which keeps the contract trivial: the relayer recomputes
`A` from the address and compares, so a wrong or forged hint matches nothing — funds in `A` can only
ever go to the address `A` derives from. No Wormhole message, nothing verified on NEAR.

- **`nearAccount` is `bytes32`, `account` is a string.** `send` names an implicit account — its id is
  the key's hex, so 32 bytes carry it. `refuel` names any account id, typically a named one
  (`relayer.hydration-whm.near`); the contract hashes the string as given. NTT pays whatever name it
  is given, so it must be an existing account we control.
- **It arrives as wNEAR.** The NEAR NTT route locks and unlocks `wrap.near`; the bot unwraps with
  `wrap.near.near_withdraw` before it can spend it on gas.
- **Fixed-size arguments make a bad input unrepresentable** where the chain allows it: a destination
  passed decoded, with no checksum to get wrong, means a typo is caught when the app decodes the
  string, never sent. The path stays defined over the string, which re-encodes deterministically.
- **One event for every coin.** `WithdrawRequested` logs the destination as `bytes`, so every emitter
  shares it whatever its address type; it is only for indexing — what pays out is `nearAccount`.
- **`sequence` is the NTT manager's**, the id the transfer's VAA carries — the same pairing the
  intents relayer uses between a settlement and its instruction.
- **The 3-argument `transfer` reverts** on a paused manager or an exhausted outbound limit rather than
  queueing, so every event has a message behind it.
- **What it cannot check** is that `nearAccount` derives from the destination. `A` is Ed25519 point
  arithmetic ([schema § 2](schema.md#2-terms--a)) that the EVM has no precompile for. The app computes
  `A`; the relayer rejects a mismatch and alerts. A mismatch pays the `A` named, as a typo in any
  address would. If outside integrators call an emitter directly, `send(amount, destination)` with the
  derivation in Solidity (golden vectors against `v1.signer`) is the upgrade; until then the api
  covers them.

### The fee — paid on Hydration, in the coin, swept into NEAR

The bots pay NEAR gas for every withdrawal. The user pays it back on Hydration, in the coin they are
sending:

```
send      fee (owner-set, in the coin) stays in the emitter; the NTT transfer carries amount − fee
refuel    TC, whenever it wants: held fee → router sell → NEAR → ntt-near → the bot's NEAR account
          → completed by hand and unwrapped: its gas tank is refilled
relay     the bots act only on transfers that have a WithdrawRequested event from an emitter
```

- **No price on chain — for now.** The fee is a flat amount in the coin's base unit, sized per chain
  against the NEAR cost below; governance retunes it when it needs to. Later the rate comes from an
  oracle (below).
- **Users never depend on a swap.** A per-transfer "buy exactly 0.01 NEAR" would track the cost
  exactly but would make every user transfer depend on the coin/NEAR liquidity on Hydration, and revert
  when it is thin. Holding the coin and swapping in batches moves that dependency to `refuel`, which
  governance runs with its own `minNearOut` and an exact `coinIn`, so the floor stays with its amount.
- **The minimum moves up.** `amount` must cover `fee` and still leave the connector's minimum.
- **Bypass is allowed, not subsidised.** A raw NTT transfer to `sha256(A)` skips the fee and the
  event, so the bots ignore it. Its owner can still finish it — `complete` and `withdraw` are
  permissionless — paying their own NEAR gas.
- **Custody.** The emitter holds the accumulated fee between `refuel` calls — small, and under the
  same governance owner as the rest of the Hydration contracts.

### Sizing the fee

What the bots spend in NEAR per withdrawal — the same for every chain, at 1 TGas = 0.0001 NEAR (the
minimum gas price, live 2026-10-17):

| Step                                                                 | First to an `A`   | Later             |
| -------------------------------------------------------------------- | ----------------- | ----------------- |
| `ntt-<coin>.complete` — 24.1 TGas + 0.00073 replay entry **[V]**     | 0.0031            | 0.0031            |
| `A`'s registration on the token, once                                | 0.00125           | —                 |
| create `A` — 1 yocto + the transfer's gas, once                      | ~0.00005          | —                 |
| `withdraw` — 20.8 TGas + 1 yocto to the signer **[V]**               | 0.0021            | 0.0021            |
| relay the delegate — ~12 TGas **[V]**                                | 0.0012            | 0.0012            |
| refund penalty on the unused part of 150 / 300 TGas attached **[I]** | ~0.002            | ~0.002            |
| **Total**                                                            | **≈ 0.0097 NEAR** | **≈ 0.0084 NEAR** |

Measured on the Zcash route ([zcash.md](zcash.md)). A `refuel` adds the router's swap fee and one
hand-completed NEAR transfer (~0.003 NEAR) per batch, not per withdrawal. Each chain's file converts
the worst case into its own unit and sets `fee` with headroom for price moves.

**Later: an oracle-priced fee.** A flat amount in the coin only tracks the cost while coin/NEAR holds.
The plan is to price the fee in NEAR and convert it per `send` at the oracle rate — coin/USD ÷
NEAR/USD from Hydration's `AggregatorV3` feeds, the same feeds the intents-v2 dispatcher reads
([intents-v2 spec § Price feeds](../../intents-v2/spec.md#4-price-feeds)). It lands as an upgrade of
each emitter: the proxy is UUPS and owned by the TC, so the TC upgrades it, appending the NEAR fee
and the feed addresses to storage. Open: whether a stale feed reverts `send` (fail closed, as the
dispatcher does) or falls back to the flat `fee`.

## `UtxoWithdraw`

The generic `utxo-withdraw` contract
([crates/near/contracts/utxo-withdraw](../../../crates/near/contracts/utxo-withdraw)), one deployment
per chain at `withdraw-<coin>.hydration-whm.near`: `chain` fixes the address format, path prefix and
miner fee (`chains/<chain>.rs`), the rest is config. Each deployment has its own set of accounts.
State and interface: [schema § 4](schema.md#4-utxowithdraw-near).

### `withdraw(address, coin)`

The terms, and which of Omni's coins to spend. The contract reads the rest and computes every number
— the full sequence is [schema § 5](schema.md#5-withdrawaddress-coin--the-signed-delegate).

**Coins.** A UTXO chain has no balances: the connector's reserve is a set of separate coins (UTXOs),
each spent whole, so a withdrawal names the one it spends and returns the rest to the connector as
change. A coin is named by its id `txid:vout` — the transaction that created it and which output it
was — and carries no amount: the connector looks its value up in its own records.

**Why the caller names the coin.** Every coin the connector returns carries `tx_bytes`, the full
transaction that created it (up to ~9 KB, as a JSON number array). A page of them is 50–100 KB per 10
coins **[V 2026-10-16]**: 49 testnet coins came to 499 KB and ran a 69 TGas `get_utxos_paged` out of
gas on testnet; 100 mainnet coins are 449 KB. Picking on chain would not fit a transaction, and a
small page would always be the same few oldest coins. So the relayer picks off-chain over the whole
set (a free view), and the contract reads only that coin with `list_utxos`.

`A` is the hex of the derived key, so the reads wait for the key. The key comes from `v1.signer`
itself — the same view the app uses — so it cannot drift from the key MPC signs with. Deriving it
locally from the root key (as Omni's connector does, `kdf.rs`) would save one hop at the cost of curve
code in the contract; not done.

**The caller controls the address**, which fixes `A`, **and which coin to spend** — an id, not a
number. Amount, user output, fee, change, target, nonce and expiry all come from the contract:

- **The user output and the fee are exact.** `coin = user output + change + fee`, with the coin's
  value, the user output and the fee all fixed — so the change is fixed too. The connector re-checks
  it all: the coin is one it holds, valued from its own records, and is removed from its set (`UTXO …
  not exist` otherwise); outputs only to `target_btc_address` or its change address; exactly one user
  output; fee within the chain's bounds and ≤ our `max_gas_fee` = `FEE` **[V `remove_vutxo_by_psbt`,
  `check_withdraw_psbt`]**.
- **Which coin is spent is Omni's business.** It changes only which part of Omni's reserve moves;
  the user output is the same. An unknown coin panics in the contract (`UnknownCoin`), one that does
  not fit (`CoinDoesNotFit`), one already taken in the connector — each before anything moves.
- **One coin, so the fee never varies.** A single coin covers any withdrawal up to the largest coin; a
  larger one cannot be built and waits. A single input also satisfies the connector's rule that change
  be smaller than the smallest input.
- **The relayer picks best fit, not largest.** A coin is locked while a withdrawal spending it is
  pending. Always taking the largest would send every withdrawal to the same coin and fail all but
  one. The smallest coin that covers spreads withdrawals across coins, keeps the big ones free for big
  withdrawals, and moves the least of Omni's reserve.
- **Races only fail.** Two withdrawals of similar size in the same block can pick the same coin: one
  goes through, the other panics in the connector and `A` is refunded in full. The connector moves a
  spent coin out of its available set, so the next attempt picks another. Above
  `passive_management_upper_limit` the connector requires more inputs than change outputs and a
  one-coin withdrawal with change fails until it consolidates.
- **Whole balance only.** Without it, anyone could split a balance into many minimum-size withdrawals
  and make the user pay the bridge fee on each. A transfer landing between the read and the execution
  is left for the next round.
- **Nonce** `block_height × 10⁶` is always valid: the runtime requires `current < nonce <
  execution_height × 10⁶` **[V nearcore `validate_delegate_action_key`]**; a new implicit key starts
  at `(creation_height − 1) × 10⁶`, and each executed delegate leaves a nonce from an earlier block.
  Two signatures from the same block share a nonce — only one executes. A failed attempt consumes
  `A`'s nonce, so an older outstanding signature is simply re-made.
- **Short-lived signatures.** `validity` is capped at `MAX_VALIDITY` = 100 blocks (~1–2 min) — the
  few blocks a relay needs. A longer-lived whole-balance delegate could be held by a third party and
  relayed after the user's next transfer lands, withdrawing only the old amount and splitting the new
  balance into extra withdrawals the user pays fees on (audit 2026-10-16, finding 2).

### `claim(address)`

Same derivation and signing, one action: `FunctionCall claim_lost_found` on the connector, 1 yocto,
no arguments. Reachable only when the connector cancels a withdrawal and its refund to `A` fails
(`lost_found[A]`) **[V `claim_lost_found`]**. The tokens come back to `A`, then go out by `withdraw`.
Encoding: [schema § 6](schema.md#6-claimaddress).

It signs only when the entry exists: a claim with nothing to claim would still consume `A`'s nonce
when relayed and cancel a withdrawal the relayer has already had signed — free griefing (audit
2026-10-16, finding 1).

### The invariant

> Every path to `v1.signer.sign` signs one of these two delegate actions, built from the address
> (which fixes `A`), the coin id, the clock and reads of `A`'s balance and the connector — and only
> one that does something: a withdrawal of a balance at the minimum or above, or a claim of an
> existing `lost_found` entry. Nothing else: no admin sign, no generic `sign(payload)`, no debug
> helper, no public callback.

`A`'s key is a full-access key, so the contract is the whole of `A`'s security. Derivation binds to
the account id, not the code: whoever can change the code controls every `A`. Same model as the NTT
manager — account keys deleted, code changed only by an owner-gated `upgrade`, ownership two-step to
`hydration.sputnik-dao.near`. Sub-account, so the id cannot be re-registered by anyone else.

## Bots

Two processes, neither with authority — each holds a NEAR gas key and nothing else:

```
ntt-near (agents/relayer)  — the Wormhole leg, one route per coin
  watch     the coin's transceiver VAAs (Hydration → NEAR, spy)
  account   the source tx receipt's WithdrawRequested with the same manager sequence → A
            (its indexed nearAccount); none → a raw transfer, its sender completes it
  redeem    ntt-<coin>.complete(vaa, A)                      0.01 NEAR attached, excess refunded

relayer (agents/utxo)      — the withdraw leg, one route per coin
  watch     WithdrawRequested from Hydration System.Events (EVM.Log, finalized blocks) — a send made
            as a substrate extrinsic has no ethereum receipt, so eth_getLogs would miss it
  check     derive(destination) == nearAccount, else the record closes as mismatch
  record    one per event, in Redis, until processed
  poll      every 30 s: balance(A) ≥ min_withdraw_amount →
              create A (1 yocto, once)
              best-fit coin over the connector's whole set (get_utxos_paged — free views)
              withdraw-<coin>.withdraw(address, coin), 1 yocto — read the signed delegate from the event
              relay { signer: bot, receiver: A, actions: [Delegate(signed)] }
  close     A's balance has left through the connector → withdrawn; else the next poll retries
```

- **One record per event, closed on the balance.** A raw NTT transfer to `sha256(A)` made without
  `send` carries no event and paid no fee; neither process acts on it, and its sender finishes it
  themselves (`complete`, then `withdraw`). Records of the same `A` close together — the contract
  withdraws the whole balance.
- **Failures put the funds back in `A`.** A coin taken by a concurrent withdrawal, a stale balance, a
  paused connector, an amount under the minimum, or a second withdrawal while one is pending (one
  pending sign per account by default **[V `get_max_pending_sign_txs`]**) panic in the connector;
  `ft_resolve_transfer` refunds `A` in full, and the next poll retries with a fresh coin.
- **Their gas comes back as NEAR** from governance's `refuel`, a NEAR-route transfer to the bot's own
  account. Neither process completes it — the bot account holds its key and does it by hand
  (`crates/near/scripts/ntt-manager/complete.ts --recipient <bot>`), then unwraps
  (`wrap.near.near_withdraw`).
- **Anyone can run them.** Inner deposits are paid by the delegate's relayer, refunded to `A` if the
  actions fail **[V nearcore `total_deposit`]**.

## Who pays what

| From                         | Pays                                                                    | For                            |
| ---------------------------- | ----------------------------------------------------------------------- | ------------------------------ |
| The user's coin              | the connector's bridge fee — Omni's charge, covering its relayer        | Omni signing, broadcasting     |
| The user's coin              | the miner fee, fixed by the contract per chain (`FEE`)                  | the transaction on its chain   |
| Bots, NEAR                   | 0.00125 NEAR token storage + 1 yocto account creation, once per `A`     | `A` on NEAR                    |
| Bots, NEAR                   | gas for `complete`, `withdraw` + MPC, the delegate tx; 1 yocto deposits | each withdrawal                |
| The user's coin, on Hydration | `fee` (owner-set), kept by the emitter                                 | swept into NEAR to refill bots |

A balance under the connector's minimum waits in `A` until the next transfer tops it up.

## Trust

Wormhole guardians and the NTT manager (as for every NTT transfer); Omni's connector for the chain
and its DAO `rainbowbridge.sputnik-dao.near`, plus its trusted relayer for liveness — already trusted,
since the connector custodies the native coin behind the NEAR token; the NEAR MPC network; the
`UtxoWithdraw` DAO, which can upgrade the contract and so controls every `A`.

## Chains

| Chain  | Emitter (Hydration) | `UtxoWithdraw` (NEAR)             | File                 |
| ------ | ------------------- | --------------------------------- | -------------------- |
| Zcash  | `ZecUtxoEmitter`    | `withdraw-zec.hydration-whm.near` | [zcash.md](zcash.md) |
| Bitcoin | — next            | `withdraw-btc.hydration-whm.near` | —                    |

A new chain is a `chains/<chain>.rs` in the contract, its own emitter on Hydration, a deployment
on NEAR, a route in each bot and a `src/chains/<chain>.ts` in `agents/utxo`.

## Open

1. **Coins with large `tx_bytes`** — the relayer's best fit does not skip them yet.
2. **Oracle-priced fee** — an emitter upgrade converting a NEAR fee at the Hydration feeds' rate
   ([Sizing the fee](#sizing-the-fee)); decide stale-feed behaviour first.
3. **Bitcoin** — a `Bitcoin` chain in the contract (its fee policy is the open part: Bitcoin's miner
   fee depends on the fee rate, not a flat ZIP-317 amount), its emitter (bech32 is variable-length),
   its deployment and routes.

Per-chain items are in each chain's file.
