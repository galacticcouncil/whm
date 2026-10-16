# UTXO withdraw — ZEC Hydration → Zcash through a derived NEAR account

How a Hydration user sends ZEC back to a Zcash address with **one Hydration call**, no NEAR account
and no third party. The call makes an NTT transfer that lands `zec.omft.near` on a NEAR account `A`
derived from the Zcash address, and publishes the address on chain; a small NEAR contract signs, for
`A`, the only thing `A` can do — withdraw through Omni's Zcash connector to that address.

Researched 2026-10-16. **[V]** verified in code, on chain or by a live call; **[I]** inferred.

## Why

Zcash → Hydration is one transfer today ([deposit.md](deposit.md)). The way back is not:
Hydration → NEAR NTT ([spec.md § Inbound](../near-ntt/spec.md#inbound--hydration--near)) pays a NEAR account,
and the user ends up holding `zec.omft.near` there. The current fix routes the NTT transfer to a
1Click deposit address, which works but:

- puts a third party (1Click and its solvers) in the path of a plain withdrawal;
- refunds into a NEAR account the user never needed, holding `zec.omft.near` they cannot use.

Omni's connector already does the Zcash leg: `ft_transfer_call(zcash-connector, Withdraw{…})` from
whoever holds the token. The missing piece is an account that holds it on the user's behalf and can
only ever send it to their address.

## Summary

- **Terms are the Zcash address.** `path = "zcash:v1:" + address` → `A` via `v1.signer`, predecessor
  our contract. One address, one `A`, permanently — every later withdrawal to it reuses `A`.
- **New on Hydration: `ZecWithdrawEmitter`.** `send(amount, zcashAddress, nearAccount)` makes the NTT
  transfer to `sha256(A)` and emits the address, keyed on the NTT sequence. The NTT message carries
  only `sha256(A)`, which cannot be inverted — the event is how the bot learns what to relay, from
  chain alone.
- **New: `UtxoWithdraw`** at `zec-withdraw.hydration-whm.near`, stateless, DAO-upgradeable like the NTT
  manager. Two methods, each signing one fixed NEAR meta-transaction for `A`.
- **New: a bot** (no authority) redeems the NTT VAA for `A`, picks the connector coin to spend, calls
  `withdraw(address, coin)` and submits the signed result, paying the NEAR gas.
- **No refund.** Funds in `A` can only leave to the address in the terms; every failure puts them
  back in `A` for the next attempt.

## The flow

```text
app      address → path → A (view: v1.signer.derived_public_key)       validates the address first
user     ZecWithdrawEmitter.send(amount, address, A)                    NTT transfer to sha256(A) + WithdrawRequested
bot      NTT VAA (ZEC transceiver → NEAR) paired with the event by seq  checks derive(address) == A
bot      ntt-zec.complete(vaa, A)                                       zec.omft.near lands on A
bot      zec-withdraw.withdraw(address, coin)                           MPC signs a delegate action for A
bot      tx { receiver: A, actions: [SignedDelegate] }                  A → zec.omft.near.ft_transfer_call(connector, Withdraw)
Omni     relayer signs and broadcasts the Zcash tx, verifies it         address receives ZEC
```

| Who | Does | Pays |
| --- | --- | --- |
| App | validates the address, derives `A` | — |
| User | `ZecWithdrawEmitter.send` on Hydration | Hydration gas; NTT delivery price to NEAR is 0 **[V]** |
| `ZecWithdrawEmitter` | pulls ZEC, NTT transfer, emits the address | — |
| Bot | `complete`, creates `A` once, `withdraw`, submits the delegate | NEAR gas, `A`'s token storage (0.00125 NEAR once), 1 yocto per call |
| `UtxoWithdraw` | derives `A`, builds and MPC-signs the delegate | — |
| Omni connector | validates the withdrawal, signs the Zcash tx through its own MPC, burns | bridge fee and Zcash fee, out of the amount |

## Terms → `A`

```
terms   = Zcash transparent address, t1… (P2PKH) or t3… (P2SH), mainnet base58check
path    = "zcash:v1:" + address                        exact string; base58 is case-sensitive
key     = v1.signer.derived_public_key({ path, predecessor: "zec-withdraw.hydration-whm.near", domain_id: 1 })
A       = lowercase hex of the 32 key bytes            NEAR implicit account
NTT to  = sha256(A)                                    what the Hydration transfer names
```

- **Validated before anyone sends.** A malformed address is the one way to strand funds: the connector
  would reject every withdrawal and nothing else can move them. The app derives `A` only for an
  address that passes the same check the contract applies — base58check, 22 bytes, prefix `1cb8` or
  `1cbd` — and golden vectors pin `address → path → A` across the app and the contract.
- **Transparent only**, as with 1Click today. The deployed connector also carries Orchard (shielded)
  support through `chain_specific_data` **[V in code]**, which needs an Orchard bundle built off-chain;
  that is a later `v2` path prefix, with its own accounts.
- **A different path prefix is a different account.** `v1` is frozen once the first user sends.

`A` exists on NEAR only once something transfers NEAR to it: the runtime then creates it with a
full-access key equal to its id **[V nearcore `action_implicit_account_creation_transfer`]**, and it
needs no balance for storage — an account under 770 bytes is a zero-balance account **[V nearcore
`ZERO_BALANCE_ACCOUNT_STORAGE_LIMIT`]**. The bot does this once per `A`; anyone can. The token
balance does not need it: `complete` registers `A` on `zec.omft.near` (NEP-145, open) and pays out,
whether or not the account exists.

## Hydration — `ZecWithdrawEmitter`

The NTT message names `sha256(A)` and nothing else: no payload, and a hash the bot cannot invert
back to `A`, let alone to the address. The address has to be on chain somewhere the bot reads, in
the same user call. It is only a **hint**, which keeps this contract trivial: the bot recomputes `A`
from the address and compares, so a wrong or forged hint matches nothing — funds in `A` can only
ever go to the address `A` derives from. No Wormhole message, nothing verified on NEAR.

```solidity
/// Send ZEC to `zcashAddress` through the derived NEAR account `nearAccount`.
function send(uint256 amount, bytes22 zcashAddress, bytes32 nearAccount)
    external payable returns (uint64 sequence);
  require amount > 0
  require zcashAddress[0..2] == 0x1cb8 (t1) or 0x1cbd (t3)
  recipient = sha256(lowercase hex of nearAccount)          the NEAR account id is that hex
  zec.safeTransferFrom(msg.sender, this, amount)
  zec.forceApprove(nttManager, amount)
  sequence = nttManager.transfer{value: msg.value}(amount, 15, recipient)
  emit WithdrawRequested(sequence, nearAccount, msg.sender, amount, zcashAddress)

event WithdrawRequested(uint64 indexed sequence, bytes32 indexed nearAccount, address indexed sender,
                        uint256 amount, bytes22 zcashAddress);
```

- **Fixed-size arguments make a bad input unrepresentable.** `zcashAddress` is the decoded
  transparent address — 2-byte prefix and 20-byte hash, no checksum to get wrong — so any value with
  a valid prefix is a payable address; a typo is caught when the app decodes the string, never sent.
  `nearAccount` is the derived public key: every `bytes32` is a valid implicit account. The path stays
  defined over the string, `"zcash:v1:" + base58check(zcashAddress)`, which is deterministic.

- **`sequence` is the NTT manager's**, the id the transfer's VAA carries — the same pairing the
  intents relayer uses between a settlement and its instruction.
- **The 3-argument `transfer` reverts** on a paused manager or an exhausted outbound limit rather than
  queueing, so every event has a message behind it.
- **What it cannot check** is that `nearAccount` derives from `zcashAddress` — EVM cannot run the MPC
  derivation. The app computes `A`; the bot rejects a mismatch and alerts. A mismatch pays the `A`
  named, as a typo in any address would.
- **Hydration facts [V]:** ZEC NTT manager `0xe20cED5f5798cD4FeBc7aE182309b9f51345e0cC`, BURNING, token
  `0x00000000000000000000000000000001000f478D` (8 dp, so no trim dust to NEAR's 8 dp);
  `quoteDeliveryPrice(15, 0x00)` = 0.
- UUPS like the other Hydration contracts; config is the manager and the token. Its migration follows
  the usual deploy → wire → ownership order.

## `UtxoWithdraw`

Implemented as the generic `utxo-withdraw` contract
([crates/near/contracts/utxo-withdraw](../../crates/near/contracts/utxo-withdraw)), one deployment per
chain: `chain` fixes the address format, path prefix and miner fee, and the rest is config. This
deployment is `chain: Zcash` at `zec-withdraw.hydration-whm.near`; a BTC one would add a `Bitcoin`
chain (its fee policy is the open part) and deploy beside it, with its own set of accounts.

```rust
#[near(contract_state)]
pub struct UtxoWithdraw {
    owner:          AccountId,
    pending_owner:  Option<AccountId>,
    chain:          Chain,       // Zcash
    mpc_signer:     AccountId,   // v1.signer
    token:          AccountId,   // zec.omft.near
    connector:      AccountId,   // zcash-connector.bridge.near
    validity:       u64,         // blocks a signed delegate stays valid, ≤ MAX_VALIDITY (100)
    withdraw_gas:   Gas,         // gas for the inner ft_transfer_call
}

FEE = chain.miner_fee(1, 2)      // Zcash: ZIP-317 for 1 input and ≤ 2 outputs is always 2 × 5,000 = 10,000 zat

#[near]
impl UtxoWithdraw {
    /// Sign A's withdrawal of its whole balance to `address`, spending the connector coin `coin`
    /// (`txid:vout`). Permissionless; 1 yocto (MPC deposit).
    #[payable] pub fn withdraw(&mut self, address: String, coin: String) -> Promise;
    /// Sign A's `claim_lost_found` on the connector, only if A has an entry. Permissionless; 1 yocto.
    #[payable] pub fn claim(&mut self, address: String) -> Promise;
    // private callbacks; owner: config, upgrade, two-step ownership
}
```

### `withdraw(address, coin)`

The terms, and which of Omni's coins to spend. The contract reads the rest and computes every number:

```
validate address (t1/t3, mainnet); coin is "txid:vout"            else panic
path = "zcash:v1:" + address
v1.signer.derived_public_key({ path, predecessor: self, domain_id: 1 })
→ on_key:  A = hex(key)
   ├─ zec.omft.near.ft_balance_of(A)                                          ┐
   ├─ connector.get_config()                    withdraw fee, change address, │ joint
   │                                            min_change_amount             │
   └─ connector.list_utxos([coin])              that coin's value             ┘
→ on_reads
   amount      = balance(A)                                       whole balance
   bridge_fee  = max(amount × fee_rate / 10,000, fee_min)         the connector's own formula
   user_out    = amount − bridge_fee − FEE                        require > 0
   require coin.value == user_out + FEE
        or coin.value ≥ user_out + FEE + min_change_amount       else panic: the caller picks another
   change      = coin.value − user_out − FEE                      omitted if 0
   output      = [ { user_out, script(address) }, { change, script(change_address) } ]
   delegate = DelegateAction {
     sender_id:        A,
     receiver_id:      zec.omft.near,
     actions: [ FunctionCall ft_transfer_call {
                  receiver_id: zcash-connector.bridge.near, amount,
                  msg: { "Withdraw": { target_btc_address: address, input: [coin "txid:vout"],
                                       output, max_gas_fee: FEE, chain_specific_data: null } } },
                gas: withdraw_gas, deposit: 1 yocto ],
     nonce:            block_height × 10⁶,
     max_block_height: block_height + validity,
     public_key:       key,
   }
   hash = sha256(borsh(SignableMessage { discriminant: 2³⁰ + 366, msg: delegate }))
   v1.signer.sign({ request: { path, payload_v2: { Eddsa: hex(hash) }, domain_id: 1 } })   1 yocto, ≥ 15 TGas
→ on_signed: emit the borsh SignedDelegateAction
```

**Coins.** Zcash, like Bitcoin, has no balances: the connector's reserve is a set of separate coins
(UTXOs), each spent whole, so a withdrawal names the one it spends and returns the rest to the
connector as change. A coin is named by its id `txid:vout` — the transaction that created it and
which output it was — and carries no amount: the connector looks its value up in its own records.
The connector keys them `txid@vout`; the `Withdraw` message takes `txid:vout`.

**Why the caller names the coin.** Every coin the connector returns carries `tx_bytes`, the full
transaction that created it (up to ~9 KB, as a JSON number array). A page of them is 50–100 KB per 10
coins **[V 2026-10-16]**: 49 testnet coins came to 499 KB and ran a 69 TGas `get_utxos_paged` out of
gas on testnet; 100 mainnet coins are 449 KB. Picking on chain would not fit a transaction, and a
small page would always be the same few oldest coins. So the bot picks off-chain over the whole set
(a free view), and the contract reads only that coin with `list_utxos`.

**Worked example** (a live connector coin): `A` holds 0.5 ZEC; the coin `959b…c099:0` holds
7,002,606,605 zat.

| | zat |
| --- | --- |
| `amount` = balance(A) | 50,000,000 |
| bridge fee, `max(0, 10,000)` | 10,000 |
| miner fee, `FEE` | 10,000 |
| user output → the user's address | 49,980,000 |
| change → Omni's change address | 7,002,606,605 − 49,980,000 − 10,000 = 6,952,616,605 |

`A` is the hex of the derived key, so the reads wait for the key. The key comes from
`v1.signer` itself — the same view the app uses — so it cannot drift from the key MPC signs with.
Deriving it locally from the root key (as Omni's connector does, `kdf.rs`) would save one hop at the
cost of curve code in the contract; not done.

**The caller controls the address**, which fixes `A`, **and which coin to spend** — an id, not a
number. Amount, user output, fee, change, target, nonce and expiry all come from the contract:

- **The user output and the fee are exact.** `coin = user output + change + fee`, with the coin's
  value, the user output and the fee all fixed — so the change is fixed too. The connector re-checks
  it all: the coin is one it holds, valued from its own records, and is removed from its set (`UTXO …
  not exist` otherwise); outputs only to `target_btc_address` or its change address; exactly one user
  output; fee ≥ the ZIP-317 minimum and ≤ our `max_gas_fee` = `FEE` **[V `remove_vutxo_by_psbt`,
  `check_withdraw_psbt`, deployed commit `d2140eca`]**.
- **Which coin is spent is Omni's business.** It changes only which part of Omni's reserve moves;
  the user output is the same. An unknown coin panics in the contract (`UnknownCoin`), one that does
  not fit (`CoinDoesNotFit`), one already taken in the connector — each before anything moves.
- **One coin, so the fee never varies.** The live set **[V 2026-10-16]** is 1,020 coins holding
  145,222 ZEC: median 82 ZEC, largest 8,480 ZEC, then 495, 491, 360, 350. A single coin covers any
  withdrawal up to the largest, 8,480 ZEC; a larger one cannot be built and waits. A single input also satisfies the connector's rule that change be
  smaller than the smallest input.
- **The bot picks best fit, not largest.** A coin is locked while a withdrawal spending it is
  pending. Always taking the largest would send every withdrawal to the same coin and fail all but
  one. The smallest coin that covers spreads withdrawals across coins, keeps the big ones free for big
  withdrawals, and moves the least of Omni's reserve.
- **Races only fail.** Two withdrawals of similar size in the same block can pick the same coin: one goes through,
  the other panics in the connector and `A` is refunded in full. The connector moves a spent coin out
  of its available set, so the next attempt picks another. Above `passive_management_upper_limit`
  (6,000 coins) the connector requires more inputs than change outputs and a one-coin withdrawal with
  change fails until it consolidates — far above today's set.
- **Whole balance only.** Without it, anyone could split a balance into many minimum-size
  withdrawals and make the user pay the bridge fee on each. A transfer landing between the read and
  the execution is left for the next round.
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

```
derived_public_key → on_key: A → connector.list_lost_found([A]) → on_lost_found
   no entry, or 0 → panic NothingToClaim         nothing signed
   entry          → claim_lost_found delegate → sign → on_signed
```

It signs only when the entry exists: a claim with nothing to claim would still consume `A`'s nonce
when relayed and cancel a withdrawal the bot has already had signed — free griefing (audit
2026-10-16, finding 1).

### The invariant

> Every path to `v1.signer.sign` signs one of these two delegate actions, built from the address
> (which fixes `A`), the coin id, the clock and reads of `A`'s balance and the connector — and only
> one that does something: a withdrawal of a balance at the minimum or above, or a claim of an
> existing `lost_found` entry. Nothing else: no admin sign, no generic `sign(payload)`, no debug
> helper, no public callback.

`A`'s key is a full-access key, so this contract is the whole of `A`'s security. Derivation binds to the
account id, not the code: whoever can change the code controls every `A`. Same model as the NTT
manager — account keys deleted, code changed only by an owner-gated `upgrade`, ownership two-step to
`hydration.sputnik-dao.near`. Sub-account, so the id cannot be re-registered by anyone else.

## Bot

```
watch     ZEC transceiver VAAs to NEAR (chain 15); for each, the WithdrawRequested log with the
          same NTT sequence — eth_getLogs by the indexed sequence, never by tx hash
check     sha256(hex(nearAccount)) == VAA recipient and derive(zcashAddress) == nearAccount, else alert
redeem    ntt-zec.complete(vaa, A)                         deposit ≥ 0.00125 + 0.005 NEAR, excess refunded
create    if A has no account: Transfer(1 yocto) to A       once
coin      best fit over the connector's whole set (get_utxos_paged, paged — a free view): the
          smallest coin paying user_out + FEE exactly or leaving change ≥ min_change_amount
sign      balance(A) ≥ min_withdraw_amount and A has no pending sign on the connector →
          zec-withdraw.withdraw(address, coin), 1 yocto    read the signed delegate from the event
submit    tx { signer: bot, receiver: A, actions: [Delegate(signed)] }
follow    connector GenerateBtcPendingInfo for A → Omni signs, broadcasts, verify_withdraw_v2
```

- **No registry.** Everything the bot needs is in Hydration logs and Wormhole VAAs; it rebuilds from
  them after a restart, and scan can index the same event. A raw NTT transfer to `sha256(A)` made
  without `send` carries no hint; it waits unredeemed and is recovered by hand (`complete`, then
  `withdraw`).
- **Retries** come from a sweep of known `A`s: any balance at or above the minimum, with nothing
  pending on the connector, is withdrawn again.
- **Failures put the funds back in `A`.** A coin taken by a concurrent withdrawal, a stale balance, a paused connector, an amount under
  the minimum, or a second withdrawal while one is pending (one pending sign per account by default
  **[V `get_max_pending_sign_txs`]**) panic in the connector; `ft_resolve_transfer` refunds `A` in
  full. The bot calls `withdraw` again.
- **Anyone can run it.** It holds a NEAR gas key and nothing else. Inner deposits are paid by the
  delegate's relayer, refunded to `A` if the actions fail **[V nearcore `total_deposit`]**.

## Fees and limits

**[V]** live `zcash-connector.bridge.near` config, 2026-10-16 (version `0.9.7-rc.3`):

| | |
| --- | --- |
| Minimum withdrawal | 100,000 zat (0.001 ZEC) |
| Bridge withdraw fee | 10,000 zat flat (0.0001 ZEC) |
| Zcash fee range | 5,000 – 1,000,000 zat; ZIP-317 minimum checked per tx |
| Inputs per withdrawal | ≤ 25 |
| Pending tx timeout | 86,400 s, then RBF or operator cancel |
| Signing | trusted relayer only (`omni-relayer.bridge.near`) |

A balance under the minimum waits in `A` until the next transfer tops it up.

**Who pays what.**

| From | Pays | For |
| --- | --- | --- |
| The user's ZEC | bridge fee 10,000 zat flat — Omni's charge, covering its relayer | Omni signing, broadcasting, verifying |
| The user's ZEC | Zcash miner fee: 10,000 zat, fixed by the contract (the ZIP-317 fee for ≤ 2 inputs) | the Zcash transaction |
| Bot, NEAR | 0.00125 NEAR token storage + 1 yocto account creation, once per `A` | `A` on NEAR |
| Bot, NEAR | gas for `complete`, `withdraw` + MPC, the delegate tx; 1 yocto deposits | each withdrawal |

**What it costs**, at NEAR ≈ $5.30 and ZEC ≈ $1,237 (CoinGecko, 2026-10-16):

| Cost | Amount | USD |
| --- | --- | --- |
| `complete`, first for an `A` — gas + 0.00125 registration + 0.00073 replay entry | ≈ 0.0042 NEAR | ≈ $0.02 |
| `complete`, later — gas + replay entry | ≈ 0.0029 NEAR | ≈ $0.015 |
| Whole NEAR side per withdrawal — adds `withdraw`, MPC, the delegate tx | ≈ 0.005–0.015 NEAR (estimate) | ≈ $0.03–0.08 |
| ZEC side — bridge fee 0.0001 + miner fee 0.0001 | ≈ 0.0002 ZEC | ≈ $0.25 |

- `complete` gas is **[V]** from two mainnet `ntt-zec` completes: 24.1 TGas burnt, 0.0022 NEAR. The
  storage comes out of the attached deposit, so explorers show only the gas as the fee. The replay
  entry is kept per VAA, forever.
- The rest of the NEAR side is an estimate until the sandbox measures it (1 TGas = 0.0001 NEAR at the
  minimum gas price; unused gas is refunded, less NEAR's refund penalty, so attach close to what is
  reserved — ~100 TGas for `complete`).
- The bot's NEAR cost is negligible. The ZEC fees are what matter: ~$0.25 per withdrawal from the
  user's amount, about 20% of the 0.001 ZEC minimum (~$1.24) and 0.2% of 0.1 ZEC.

## Compared with 1Click

| | 1Click (now) | `UtxoWithdraw` |
| --- | --- | --- |
| Deposit target | 1Click deposit address, new per quote | `A`, one per Zcash address, reused |
| Who moves the funds | 1Click + a solver | Omni's connector, which already backs `zec.omft.near` |
| On failure | refund to a NEAR account the user did not need | funds stay in `A`, next attempt |
| Trust added | 1Click, solver liveness | `UtxoWithdraw` (DAO), MPC network |

## Trust

Wormhole guardians and the NTT manager (as for every NTT transfer); Omni's Zcash connector and its
DAO `rainbowbridge.sputnik-dao.near`, plus its trusted relayer for liveness — already trusted, since
the connector custodies the native ZEC behind `zec.omft.near`; the NEAR MPC network; the
`UtxoWithdraw` DAO, which can upgrade the contract and so controls every `A`.

## Open

1. **Gas.** The SDK attaches 100 TGas to `ft_transfer_call`, but the connector's `ft_on_transfer`
   schedules a light-client read and a 100 TGas static callback. Measure on the mainnet wasm; size
   `withdraw_gas`, and the bot's outer transaction, from the result.
2. **`derived_public_key` called cross-contract** from `UtxoWithdraw` — a view method, expected to work
   as a plain function call; confirm in the sandbox.
3. **Sandbox.** Mainnet wasm of `zec.omft.near`, `zcash-connector.bridge.near` and our `ntt-zec`; an
   Ed25519 mock signer; the delegate executed end to end, including the failure refund and
   `claim_lost_found`.
4. **Mainnet canary.** 0.002 ZEC, Hydration → Zcash `t1`, with a fresh address.

Resolved: Omni's relayer picks up and signs a pending withdrawal from any account, `A` included, and
pays its own NEAR gas (confirmed with the team, 2026-10-16).
