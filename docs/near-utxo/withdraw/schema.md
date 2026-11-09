# SCHEMA — UTXO withdraw

Interfaces, encodings and records for withdrawing a UTXO coin from Hydration to its own chain.
Design and rationale: [spec.md](spec.md). Per-chain addresses, formats and values:
[zcash.md](zcash.md).

## Message topology

```text
Hydration   <Coin>UtxoEmitter.send ─┬─ NTT transfer (manager seq) ─ to = sha256(hex A) ─▶ VAA, chain 73
                                    └─ WithdrawRequested(seq, A, sender, net, fee, destination)   same tx
NEAR        ntt-<coin>.complete(vaa, A)                                 the coin's token → A
            withdraw-<coin>.withdraw(address, coin) ─ v1.signer.sign ─▶ signed DelegateAction for A
            relay: A → token.ft_transfer_call(connector, Withdraw{…})
UTXO chain  connector signs and broadcasts: user output → address, change → Omni
```

One id ties the Hydration side together: the coin's **NTT manager sequence** — the transfer's id in
its VAA and `WithdrawRequested.sequence`. On NEAR everything keys on `A`.

## 1. Constants

Shared by every chain; each chain's own are in its file ([zcash.md § Constants](zcash.md#constants)).

| Name               | Value                                                                  |
| ------------------ | ---------------------------------------------------------------------- |
| Wormhole chain ids | Hydration 73, NEAR 15                                                  |
| MPC signer         | `v1.signer`, domain 1 (Ed25519)                                        |
| NEAR NttManager, Hydration | `0x374E5239a2342Be6Bf31B410EC03984D03A8b7dE` — `refuel`'s rail |
| NEAR NTT manager, NEAR | `ntt-near.hydration-whm.near`                                      |
| `MAX_VALIDITY`     | 100 blocks                                                             |
| `TRIM_UNIT` (NEAR) | 1e16 — NTT carries 8 of NEAR's 24 dp                                   |
| Delegate signing   | `sha256(borsh(SignableMessage { discriminant: 2³⁰ + 366, msg }))`      |

## 2. Terms → `A`

```
terms   = a destination address on the chain, validated as its contract validates it
path    = "<chain>:v1:" + address                      exact string
key     = v1.signer.derived_public_key({ path, predecessor: "withdraw-<coin>.hydration-whm.near", domain_id: 1 })
A       = lowercase hex of the 32 key bytes            NEAR implicit account
NTT to  = sha256(A)                                    what the Hydration transfer names
```

`A = compress(ROOT_ed25519 + tweak·G)`, `tweak = sha3("near-mpc-recovery v0.1.0 epsilon derivation:"
‖ predecessor ‖ "," ‖ path)`. Path prefixes, address formats and golden vectors per chain:
[zcash.md § Addresses](zcash.md#addresses).

## 3. The emitter (Hydration)

One per coin. The destination's Solidity type is the chain's (Zcash: `bytes22`, [zcash.md §
Emitter](zcash.md#emitter)); everything else is shared.

```solidity
/// Send the coin to `destination` through the derived NEAR account `nearAccount`.
function send(uint256 amount, <Destination> destination, bytes32 nearAccount)
    external returns (uint64 sequence);
  require destination is a valid address for the chain
  require nearAccount != 0
  require amount ≥ fee + MIN_WITHDRAW                       the connector's minimum
  net = amount − fee
  token.safeTransferFrom(msg.sender, this, amount)          fee stays in the contract
  recipient = sha256(lowercase hex of nearAccount)          the NEAR account id is that hex
  sequence = _bridge(coinManager, net, recipient)
  emit WithdrawRequested(sequence, nearAccount, msg.sender, net, fee, abi.encodePacked(destination))

/// Owner (Hydration governance): sell `coinIn` of the held fee for NEAR and send it to `account` on NEAR.
function refuel(uint256 coinIn, uint256 minNearOut, string account) external onlyOwner returns (uint64 sequence);
  router sell(coin → NEAR, coinIn, minNearOut)              dispatch precompile, as IntentEmitter swaps
  nearOut = NEAR balance, trimmed to TRIM_UNIT
  sequence = _bridge(nearManager, nearOut, sha256(account))
  emit Refueled(sequence, coinIn, nearOut, account)

/// Both legs: quote the delivery price (0 today, paid from the contract's balance), approve, and the
/// 3-argument NTT transfer to NEAR (chain 15).
function _bridge(address manager, uint256 amount, bytes32 recipient) internal returns (uint64 sequence);

function setFee(uint256 fee) external onlyOwner;           the coin's base unit
function set<Coin>NttManager(address) external onlyOwner;
function setNearNttManager(address) external onlyOwner;
function sweep(address asset, address to, uint256 amount) external onlyOwner;   trim dust, stray tokens
```

### Events

```solidity
event WithdrawRequested(uint64 indexed sequence, bytes32 indexed nearAccount, address indexed sender,
                        uint256 amount, uint256 fee, bytes destination);
event Refueled(uint64 indexed sequence, uint256 coinIn, uint256 nearOut, string account);
```

- **`WithdrawRequested` is the same for every coin's emitter.** `destination` is `bytes`, so any
  address type fits; readers decode it per chain. Only for indexing — what pays out is `nearAccount`.
- **The indexed topics are `sequence` (1) and `nearAccount` (2)** — all `ntt-near` reads.
- `sequence` is the NTT manager's (the coin's for `WithdrawRequested`, NEAR's for `Refueled`), the id
  the transfer's VAA carries.

## 4. `UtxoWithdraw` (NEAR)

```rust
#[near(contract_state)]
pub struct UtxoWithdraw {
    owner:          AccountId,
    pending_owner:  Option<AccountId>,
    chain:          Chain,       // address format, path prefix, miner fee — chains/<chain>.rs
    mpc_signer:     AccountId,   // v1.signer
    token:          AccountId,   // the coin's NEAR token
    connector:      AccountId,   // the chain's Omni connector
    validity:       u64,         // blocks a signed delegate stays valid, ≤ MAX_VALIDITY
    withdraw_gas:   Gas,         // gas for the inner ft_transfer_call
}

FEE = chain.miner_fee(1, 2)      // one input, ≤ 2 outputs

#[near]
impl UtxoWithdraw {
    /// Sign A's withdrawal of its whole balance to `address`, spending the connector coin `coin`
    /// (`txid:vout`). Permissionless; 1 yocto (MPC deposit).
    #[payable] pub fn withdraw(&mut self, address: String, coin: String) -> Promise;
    /// Sign A's `claim_lost_found` on the connector, only if A has an entry. Permissionless; 1 yocto.
    #[payable] pub fn claim(&mut self, address: String) -> Promise;
    // views: get_params, path_of; private callbacks; owner: config, upgrade, two-step ownership
}
```

Both emit NEP-297 `{ standard: "whm-utxo-withdraw", event: "signed", data: [{ …, signed_delegate }] }`
— `signed_delegate` is the borsh `SignedDelegateAction`, base64.

## 5. `withdraw(address, coin)` — the signed delegate

```
validate address for the chain; coin is "txid:vout"               else panic
path = "<chain>:v1:" + address
v1.signer.derived_public_key({ path, predecessor: self, domain_id: 1 })
→ on_key:  A = hex(key)
   ├─ token.ft_balance_of(A)                                                  ┐
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
     receiver_id:      token,
     actions: [ FunctionCall ft_transfer_call {
                  receiver_id: connector, amount,
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

The `Withdraw` message is Omni's satoshi-bridge format, the same for every connector built on it;
`target_btc_address` carries the address whatever the chain. Coins: the connector keys them
`txid@vout`; the message takes `txid:vout`.

**Relay:** `{ signer: relayer, receiver: A, actions: [Delegate(signed)] }`.

## 6. `claim(address)`

```
derived_public_key → on_key: A → connector.list_lost_found([A]) → on_lost_found
   no entry, or 0 → panic NothingToClaim         nothing signed
   entry          → DelegateAction { A → connector, FunctionCall claim_lost_found {}, 1 yocto }
                    → sign → on_signed
```

## 7. Relayer records (`agents/utxo`)

Redis, prefix `utxo` (load-bearing):

| Key                       | Value                                                                                                                  |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `utxo:cursor`             | last Hydration block read                                                                                              |
| `utxo:<chain>:<sequence>` | JSON record: `chain, sequence, account, address, amount, block, state, createdAt, updatedAt, withdrawTx?, lastError?` |
| `utxo:open`               | set of open `<chain>:<sequence>`                                                                                       |

`state`: `open` → `withdrawn` (closed, kept 30 days) · `mismatch` (the event's `nearAccount` is not
what its `destination` derives — closed, never worked).
