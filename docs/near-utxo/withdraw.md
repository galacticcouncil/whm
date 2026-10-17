# UTXO withdraw — ZEC Hydration → Zcash through a derived NEAR account

How a Hydration user sends ZEC back to a Zcash address with **one Hydration call**, no NEAR account
and no third party. The call makes an NTT transfer that lands `zec.omft.near` on a NEAR account `A`
derived from the Zcash address, and publishes the address on chain; a small NEAR contract signs, for
`A`, the only thing `A` can do — withdraw through Omni's Zcash connector to that address.

Researched 2026-10-16. **[V]** verified in code, on chain or by a live call; **[I]** inferred.

## Why

Zcash → Hydration is one transfer today ([deposit.md](deposit.md)). The way back is not:
Hydration → NEAR NTT ([spec.md § Inbound](../near-ntt/spec.md#inbound--hydration--near)) pays a NEAR account,
and the user ends up holding `zec.omft.near` there.

Omni's connector already does the Zcash leg: `ft_transfer_call(zcash-connector, Withdraw{…})` from
whoever holds the token. The missing piece is an account that holds it on the user's behalf and can
only ever send it to their address.

## Summary

- **Terms are the Zcash address.** `path = "zcash:v1:" + address` → `A` via `v1.signer`, predecessor
  our contract. One address, one `A`, permanently — every later withdrawal to it reuses `A`.
- **New on Hydration: `ZecUtxoEmitter`.** `send(amount, zcashAddress, nearAccount)` keeps a small
  fee in ZEC, makes the NTT transfer of the rest to `sha256(A)` and emits the address, keyed on the
  NTT sequence. The NTT message carries only `sha256(A)`, which cannot be inverted — the event is how
  the bot learns what to relay, from chain alone. Governance's `refuel` turns the fees into NEAR
  for the bot's gas.
- **New: `UtxoWithdraw`** at `withdraw-zec.hydration-whm.near`, stateless, DAO-upgradeable like the NTT
  manager. Two methods, each signing one fixed NEAR meta-transaction for `A`.
- **New: a bot** (no authority) redeems the NTT VAA for `A`, picks the connector coin to spend, calls
  `withdraw(address, coin)` and submits the signed result, paying the NEAR gas.
- **No refund.** Funds in `A` can only leave to the address in the terms; every failure puts them
  back in `A` for the next attempt.

## The flow

```text
USER (Hydration)
  ZecUtxoEmitter.send(amount, zcashAddress, nearAccount)          app derives nearAccount = A first (view: v1.signer)
    ├─ pull amount ZEC from the user
    ├─ keep fee (zat, owner-set)                                   ← stays in the emitter
    ├─ require amount − fee ≥ 0.001 ZEC
    ├─ NttManager.transfer(amount − fee, 15, sha256(A))            ZEC burned on Hydration
    └─ emit WithdrawRequested(seq, A, sender, amount − fee, fee, zcashAddress)
                │
                ▼  Wormhole VAA (chain 73, ZEC transceiver, seq)
BOT (NEAR) — relays only VAAs that have a WithdrawRequested event from our emitter (= fee paid)
  ├─ check   sha256(hex A) == VAA recipient,  derive(zcashAddress) == A
  ├─ ntt-zec.complete(vaa, A)                                       registers A, unlocks zec.omft.near to A
  ├─ create A (1 yocto, first time only)
  ├─ pick a coin (best fit, off-chain)
  ├─ withdraw-zec.withdraw(zcashAddress, coin)                      MPC signs A's withdrawal
  └─ relay the signed delegate                                      UnknownCoin / CoinDoesNotFit → pick again
                │
                ▼
OMNI (NEAR → Zcash)
  zcash-connector: burns, signs and broadcasts the Zcash tx
  → zcashAddress receives (amount − fee) − 0.0001 bridge fee − 0.0001 miner fee

FEE LOOP (TC, whenever it wants)
  ZecUtxoEmitter.refuel(zecIn, minNearOut, account)                 owner = Hydration governance
    ├─ router sell zecIn of the held fee ZEC → NEAR                 slippage ≥ minNearOut
    └─ ntt-near transfer(NEAR, 15, sha256(account))                 account named per call
                │
                ▼  Wormhole VAA (chain 73, NEAR transceiver)
  bot: ntt-near.complete(vaa, account)                              wNEAR to the bot's account
       wrap.near.near_withdraw(amount)                              → native NEAR: gas tank refilled
```

| Who                       | Does                                                                    | Pays                                                                                               |
| ------------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| App                       | validates the address, derives `A`                                      | —                                                                                                  |
| User                      | `ZecUtxoEmitter.send` on Hydration                                      | `fee` in ZEC; Hydration gas; NTT delivery price to NEAR is 0 **[V]**                               |
| `ZecUtxoEmitter`          | pulls ZEC, keeps `fee`, NTT transfer of the rest, emits the address     | —                                                                                                  |
| Bot                       | `complete`, creates `A` once, `withdraw`, submits the delegate          | NEAR gas, `A`'s token storage (0.00125 NEAR once), 1 yocto per call — refilled from the fees       |
| TC (Hydration governance) | sets `fee`; `refuel` turns the held fee ZEC into NEAR for the bot       | —                                                                                                  |
| `UtxoWithdraw`            | derives `A`, builds and MPC-signs the delegate                          | —                                                                                                  |
| Omni connector            | validates the withdrawal, signs the Zcash tx through its own MPC, burns | bridge fee and Zcash fee, out of the amount                                                        |

## Terms → `A`

```
terms   = Zcash transparent address, t1… (P2PKH) or t3… (P2SH), mainnet base58check
path    = "zcash:v1:" + address                        exact string; base58 is case-sensitive
key     = v1.signer.derived_public_key({ path, predecessor: "withdraw-zec.hydration-whm.near", domain_id: 1 })
A       = lowercase hex of the 32 key bytes            NEAR implicit account
NTT to  = sha256(A)                                    what the Hydration transfer names
```

- **Validated before anyone sends.** A malformed address is the one way to strand funds: the connector
  would reject every withdrawal and nothing else can move them. The app derives `A` only for an
  address that passes the same check the contract applies — base58check, 22 bytes, prefix `1cb8` or
  `1cbd` — and golden vectors pin `address → path → A` across the app and the contract.
- **Transparent only.** The deployed connector also carries Orchard (shielded)
  support through `chain_specific_data` **[V in code]**, which needs an Orchard bundle built off-chain;
  that is a later `v2` path prefix, with its own accounts.
- **A different path prefix is a different account.** `v1` is frozen once the first user sends.

`A` exists on NEAR only once something transfers NEAR to it: the runtime then creates it with a
full-access key equal to its id **[V nearcore `action_implicit_account_creation_transfer`]**, and it
needs no balance for storage — an account under 770 bytes is a zero-balance account **[V nearcore
`ZERO_BALANCE_ACCOUNT_STORAGE_LIMIT`]**. The bot does this once per `A`; anyone can. The token
balance does not need it: `complete` registers `A` on `zec.omft.near` (NEP-145, open) and pays out,
whether or not the account exists.

## Hydration — `ZecUtxoEmitter`

The NTT message names `sha256(A)` and nothing else: no payload, and a hash the bot cannot invert
back to `A`, let alone to the address. The address has to be on chain somewhere the bot reads, in
the same user call. It is only a **hint**, which keeps this contract trivial: the bot recomputes `A`
from the address and compares, so a wrong or forged hint matches nothing — funds in `A` can only
ever go to the address `A` derives from. No Wormhole message, nothing verified on NEAR.

```solidity
/// Send ZEC to `zcashAddress` through the derived NEAR account `nearAccount`.
function send(uint256 amount, bytes22 zcashAddress, bytes32 nearAccount)
    external returns (uint64 sequence);
  require zcashAddress[0..2] == 0x1cb8 (t1) or 0x1cbd (t3)
  require nearAccount != 0
  require amount ≥ fee + MIN_WITHDRAW (100,000 zat — the connector's minimum)
  net = amount − fee
  zec.safeTransferFrom(msg.sender, this, amount)            fee stays in the contract
  recipient = sha256(lowercase hex of nearAccount)          the NEAR account id is that hex
  sequence = _bridge(zecManager, net, recipient)
  emit WithdrawRequested(sequence, nearAccount, msg.sender, net, fee, abi.encodePacked(zcashAddress))

/// Owner (Hydration governance): sell `zecIn` of the held fee ZEC for NEAR and send it to `account` on NEAR.
function refuel(uint256 zecIn, uint256 minNearOut, string account) external onlyOwner returns (uint64 sequence);
  router sell(ZEC → NEAR, zecIn, minNearOut)                dispatch precompile, as IntentEmitter swaps;
                                                            exact zecIn, so the floor stays with its amount
  nearOut = NEAR balance, trimmed to 1e16                   NTT carries 8 of NEAR's 24 dp
  sequence = _bridge(nearManager, nearOut, sha256(account)) the NEAR NTT route (ntt-near.hydration-whm.near)
  emit Refueled(sequence, zecIn, nearOut, account)

/// Both legs: quote the delivery price (0 today, paid from the contract's balance), approve, and the
/// 3-argument NTT transfer to NEAR (chain 15).
function _bridge(address manager, uint256 amount, bytes32 recipient) internal returns (uint64 sequence);

function setFee(uint256 fee) external onlyOwner;           zat
function setZecNttManager(address) external onlyOwner;
function setNearNttManager(address) external onlyOwner;
function sweep(address asset, address to, uint256 amount) external onlyOwner;   trim dust, stray tokens

event WithdrawRequested(uint64 indexed sequence, bytes32 indexed nearAccount, address indexed sender,
                        uint256 amount, uint256 fee, bytes destination);
event Refueled(uint64 indexed sequence, uint256 zecIn, uint256 nearOut, string account);
```

- **`nearAccount` is `bytes32`, `account` is a string.** `send` names an implicit account — its id is
  the key's hex, so 32 bytes carry it. `refuel` names any account id, typically a named one
  (`relayer.hydration-whm.near`); the contract hashes the string as given. NTT pays whatever name it
  is given, so it must be an existing account we control.
- **It arrives as wNEAR.** The NEAR NTT route locks and unlocks `wrap.near`; the bot unwraps with
  `wrap.near.near_withdraw` before it can spend it on gas.

### The fee — paid on Hydration, in ZEC, swept into NEAR

The bot pays NEAR gas for every withdrawal (≈ 0.005–0.008 NEAR, measured on the mainnet canary). The
user pays it back on Hydration, in the asset they are sending:

```
send      fee (zat, owner-set) stays in ZecUtxoEmitter; the NTT transfer carries amount − fee
refuel    TC, whenever it wants: held ZEC → router sell → NEAR → ntt-near → the bot's NEAR account
          → the bot completes its own transfer and unwraps: its gas tank is refilled
relay     the bot relays only transfers that have a WithdrawRequested event from this contract
```

- **No price on chain — for now.** The fee is a flat 10,000 zat, like Omni's own bridge fee. Against
  the worst-case NEAR cost of a withdrawal (≈ 0.0097 NEAR, first one to an `A`; ≈ 4,200 zat at NEAR
  $5.05 / ZEC $1,156, 2026-10-17) it has ~2.4× room for ZEC/NEAR moves, and governance retunes `fee`
  when it needs to. Later the rate comes from an oracle — see [Sizing the fee](#sizing-the-fee).
- **Users never depend on a swap.** A per-transfer "buy exactly 0.01 NEAR" would track the cost
  exactly but would make every user transfer depend on ZEC/NEAR liquidity on Hydration, and revert
  when it is thin. Holding ZEC and swapping in batches moves that dependency to `refuel`, which
  governance runs with its own `minNearOut`.
- **The minimum moves up.** `amount` must cover `fee` and still leave the connector's 0.001 ZEC.
- **Bypass is allowed, not subsidised.** A raw NTT transfer to `sha256(A)` skips the fee and the
  event, so the bot ignores it. Its owner can still finish it — `complete` and `withdraw` are
  permissionless — paying their own NEAR gas.
- **Custody.** The contract holds the accumulated fee ZEC between `refuel` calls — small, and under the
  same governance owner as the rest of the Hydration contracts.

### Sizing the fee

What the bots spend in NEAR per withdrawal, at 1 TGas = 0.0001 NEAR (the minimum gas price, live
2026-10-17):

| Step                                                               | First to an `A` | Later       |
| ------------------------------------------------------------------ | --------------- | ----------- |
| `ntt-zec.complete` — 24.1 TGas + 0.00073 replay entry **[V]**      | 0.0031          | 0.0031      |
| `A`'s registration on `zec.omft.near`, once                        | 0.00125         | —           |
| create `A` — 1 yocto + the transfer's gas, once                    | ~0.00005        | —           |
| `withdraw-zec.withdraw` — 20.8 TGas + 1 yocto to the signer **[V]** | 0.0021          | 0.0021      |
| relay the delegate — ~12 TGas **[V]**                              | 0.0012          | 0.0012      |
| refund penalty on the unused part of 150 / 300 TGas attached **[I]** | ~0.002          | ~0.002      |
| **Total**                                                          | **≈ 0.0097 NEAR** | **≈ 0.0084 NEAR** |

At NEAR $5.05 / ZEC $1,156 (CoinGecko, 2026-10-17) the worst case is ≈ $0.049 ≈ 4,200 zat. `fee` =
10,000 zat (≈ $0.116 ≈ 0.023 NEAR) covers it ~2.4× and matches Omni's flat bridge fee; the smallest
`send` is then 110,000 zat. A `refuel` adds the router's swap fee and one hand-completed NEAR
transfer (~0.003 NEAR) per batch, not per withdrawal.

**Later: an oracle-priced fee.** A flat zat amount only tracks the cost while ZEC/NEAR holds. The
plan is to price the fee in NEAR and convert it per `send` at the oracle rate — ZEC/USD ÷ NEAR/USD
from Hydration's `AggregatorV3` feeds, the same feeds the intents-v2 dispatcher reads
([intents-v2 spec § Price feeds](../intents-v2/spec.md#4-price-feeds)). It lands as an upgrade of
`ZecUtxoEmitter`: the proxy is UUPS and owned by the TC, so the TC upgrades it, appending the NEAR fee
and the feed addresses to storage. Open: whether a stale feed reverts `send` (fail closed, as the
dispatcher does) or falls back to the flat `fee`.

- **Fixed-size arguments make a bad input unrepresentable.** `zcashAddress` is the decoded
  transparent address — 2-byte prefix and 20-byte hash, no checksum to get wrong — so any value with
  a valid prefix is a payable address; a typo is caught when the app decodes the string, never sent.
  `nearAccount` is the derived public key: every `bytes32` is a valid implicit account. The path stays
  defined over the string, `"zcash:v1:" + base58check(zcashAddress)`, which is deterministic.

- **`sequence` is the NTT manager's**, the id the transfer's VAA carries — the same pairing the
  intents relayer uses between a settlement and its instruction.
- **The 3-argument `transfer` reverts** on a paused manager or an exhausted outbound limit rather than
  queueing, so every event has a message behind it.
- **What it cannot check** is that `nearAccount` derives from `zcashAddress`. `A` is
  `compress(ROOT_ed25519 + tweak·G)` with `tweak = sha3("near-mpc-recovery v0.1.0 epsilon derivation:"
‖ predecessor ‖ "," ‖ path)` — Ed25519 point arithmetic that the EVM has no precompile for. The app
  computes `A`; the bot rejects a mismatch and alerts. A mismatch pays the `A` named, as a typo in any
  address would. If outside integrators call this contract directly, `send(amount, zcashAddress)`
  with the derivation in Solidity (golden vectors against `v1.signer`) is the upgrade; until then an
  SDK helper `deriveAccount(zcashAddress)` covers them.
- **Hydration facts [V]:** ZEC NTT manager `0xe20cED5f5798cD4FeBc7aE182309b9f51345e0cC`, BURNING, token
  `0x00000000000000000000000000000001000f478D` (8 dp, so no trim dust to NEAR's 8 dp);
  `quoteDeliveryPrice(15, 0x00)` = 0. NEAR NTT manager (for `refuel`)
  `0x374E5239a2342Be6Bf31B410EC03984D03A8b7dE`, peered with `ntt-near.hydration-whm.near`.
- UUPS like the other Hydration contracts; config is the ZEC and NEAR NTT managers and `fee`; the
  tokens are read from the managers, the bot's account is named per `refuel` call. Owner is
  Hydration governance, like `IntentEmitter`. Its migration follows the usual deploy → wire →
  ownership order.

## `UtxoWithdraw`

Implemented as the generic `utxo-withdraw` contract
([crates/near/contracts/utxo-withdraw](../../crates/near/contracts/utxo-withdraw)), one deployment per
chain: `chain` fixes the address format, path prefix and miner fee, and the rest is config. This
deployment is `chain: Zcash` at `withdraw-zec.hydration-whm.near`; a BTC one would add a `Bitcoin`
chain (its fee policy is the open part) and deploy beside it as `withdraw-btc.hydration-whm.near`,
with its own set of accounts.

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

|                                  | zat                                                 |
| -------------------------------- | --------------------------------------------------- |
| `amount` = balance(A)            | 50,000,000                                          |
| bridge fee, `max(0, 10,000)`     | 10,000                                              |
| miner fee, `FEE`                 | 10,000                                              |
| user output → the user's address | 49,980,000                                          |
| change → Omni's change address   | 7,002,606,605 − 49,980,000 − 10,000 = 6,952,616,605 |

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

Two processes, neither with authority — each holds a NEAR gas key and nothing else:

```
ntt-near (agents/relayer)  — the Wormhole leg
  watch     the ZEC transceiver's VAAs (Hydration → NEAR, spy)
  account   the source tx receipt's WithdrawRequested with the same manager sequence → A
            (its indexed nearAccount); none → a raw transfer, its sender completes it
  redeem    ntt-zec.complete(vaa, A)                         0.01 NEAR attached, excess refunded

relayer (agents/utxo)      — the withdraw leg
  watch     WithdrawRequested from Hydration System.Events (EVM.Log, finalized blocks) — a send made
            as a substrate extrinsic has no ethereum receipt, so eth_getLogs would miss it
  check     derive(destination) == nearAccount, else the record closes as mismatch
  record    one per event, in Redis, until processed
  poll      every 30 s: balance(A) ≥ min_withdraw_amount →
              create A (1 yocto, once)
              best-fit coin over the connector's whole set (get_utxos_paged — free views)
              withdraw-zec.withdraw(address, coin), 1 yocto — read the signed delegate from the event
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
- **Its gas comes back as NEAR** from governance's `refuel`, a NEAR-route transfer to the bot's own
  account. Neither process completes it — the bot account holds its key and does it by hand
  (`crates/near/scripts/ntt-manager/complete.ts --recipient <bot>`), then unwraps
  (`wrap.near.near_withdraw`).
- **Anyone can run them.** Inner deposits are paid by the delegate's relayer, refunded to `A` if the
  actions fail **[V nearcore `total_deposit`]**.

## Fees and limits

**[V]** live `zcash-connector.bridge.near` config, 2026-10-16 (version `0.9.7-rc.3`):

|                       |                                                       |
| --------------------- | ----------------------------------------------------- |
| Minimum withdrawal    | 100,000 zat (0.001 ZEC)                               |
| Bridge withdraw fee   | 10,000 zat flat (0.0001 ZEC)                          |
| Zcash fee range       | 5,000 – 1,000,000 zat; ZIP-317 minimum checked per tx |
| Inputs per withdrawal | ≤ 25                                                  |
| Pending tx timeout    | 86,400 s, then RBF or operator cancel                 |
| Signing               | trusted relayer only (`omni-relayer.bridge.near`)     |

A balance under the minimum waits in `A` until the next transfer tops it up.

**Who pays what.**

| From                         | Pays                                                                                | For                                   |
| ---------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------- |
| The user's ZEC               | bridge fee 10,000 zat flat — Omni's charge, covering its relayer                    | Omni signing, broadcasting, verifying |
| The user's ZEC               | Zcash miner fee: 10,000 zat, fixed by the contract (the ZIP-317 fee for ≤ 2 inputs) | the Zcash transaction                 |
| Bot, NEAR                    | 0.00125 NEAR token storage + 1 yocto account creation, once per `A`                 | `A` on NEAR                           |
| Bot, NEAR                    | gas for `complete`, `withdraw` + MPC, the delegate tx; 1 yocto deposits             | each withdrawal                       |
| The user's ZEC, on Hydration | `fee` (owner-set zat), kept by `ZecUtxoEmitter`                                     | swept into NEAR to refill the bot     |

**What it costs**, at NEAR ≈ $5.30 and ZEC ≈ $1,237 (CoinGecko, 2026-10-16):

| Cost                                                                             | Amount             | USD          |
| -------------------------------------------------------------------------------- | ------------------ | ------------ |
| `complete`, first for an `A` — gas + 0.00125 registration + 0.00073 replay entry | ≈ 0.0042 NEAR      | ≈ $0.02      |
| `complete`, later — gas + replay entry                                           | ≈ 0.0029 NEAR      | ≈ $0.015     |
| Whole NEAR side per withdrawal — adds `withdraw`, MPC, the delegate tx           | ≈ 0.005–0.008 NEAR | ≈ $0.03–0.04 |
| ZEC side — bridge fee 0.0001 + miner fee 0.0001                                  | ≈ 0.0002 ZEC       | ≈ $0.25      |

- `complete` gas is **[V]** from two mainnet `ntt-zec` completes: 24.1 TGas burnt, 0.0022 NEAR. The
  storage comes out of the attached deposit, so explorers show only the gas as the fee. The replay
  entry is kept per VAA, forever.
- The rest of the NEAR side is **[V]** from the mainnet canary (2026-10-16): `withdraw` 20.8 TGas,
  the relay ~12 TGas (1 TGas = 0.0001 NEAR at the minimum gas price; unused gas is refunded, less
  NEAR's refund penalty, so attach close to what is reserved — ~100 TGas for `complete`).
- The bot's NEAR cost is negligible. The ZEC fees are what matter: ~$0.25 per withdrawal from the
  user's amount, about 20% of the 0.001 ZEC minimum (~$1.24) and 0.2% of 0.1 ZEC.

## Trust

Wormhole guardians and the NTT manager (as for every NTT transfer); Omni's Zcash connector and its
DAO `rainbowbridge.sputnik-dao.near`, plus its trusted relayer for liveness — already trusted, since
the connector custodies the native ZEC behind `zec.omft.near`; the NEAR MPC network; the
`UtxoWithdraw` DAO, which can upgrade the contract and so controls every `A`.

## Verified live

- **Mainnet canary, 2026-10-16.** 0.001 ZEC: Hydration NTT transfer to `sha256(A)` → `ntt-zec.complete`
  → `withdraw-zec.withdraw` → Omni. Zcash tx
  `a63e6119df0bd73e6160515d8f4abe15327e29df21f637245ef334d8c784ae34` (block 3,520,026): 80,000 zat to
  `t1XVScGC…`, 99,910,000 zat change to Omni; connector record: 10,000 bridge fee, 10,000 miner fee.
  Omni's relayer signed 12 s after the request. The connector parsed and accepted our `Withdraw`
  message.
- **Gas.** `withdraw_gas` = 200 TGas carries the connector's `ft_on_transfer` and its 100 TGas
  callback; `withdraw` burns 20.8 TGas end to end on mainnet.
- **`derived_public_key` as a cross-contract call** — on testnet and mainnet.
- **Testnet** (`ZcashTestnet`): `claim` signed by the real `v1.signer-prod.testnet`, relayed, executed
  by the connector as `A`; `withdraw` reads and the `BelowMinimum` stop; `upgrade` + `migrate` on a
  keyless contract.
- Omni's relayer signs a pending withdrawal from any account, `A` included, and pays its own NEAR gas.

## Open

1. **Deploy `ZecUtxoEmitter`** — `pnpm migrate:utxo-emitter-zec` (set `ZEC_FEE` first; verified on a
   Hydration fork). Then fill its address into `agents/relayer` `ntt-near` routes and
   `agents/utxo` relayer routes (with its deployment block), and run both.
2. **Ownership handover** — `WITHDRAW_NEW_OWNER=hydration.sputnik-dao.near`, re-run the migration
   (keys deleted, DAO accepts).
3. **Coins with large `tx_bytes`** — the relayer's best fit does not skip them yet.
4. **Oracle-priced fee** — a `ZecUtxoEmitter` upgrade converting a NEAR fee at the Hydration feeds'
   ZEC/NEAR rate ([Sizing the fee](#sizing-the-fee)); decide stale-feed behaviour first.
