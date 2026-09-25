# NEAR NTT — Pre-implementation checks

What [spec.md](spec.md) depended on before a line of contract code was written, and what each check
found. Run 2026-09-23 against NEAR mainnet (`rpc.mainnet.near.org`, `finality: final`), Wormholescan,
and the guardian source in the local `wormhole` checkout.

| #   | Question                                   | Result                              |
| --- | ------------------------------------------ | ----------------------------------- |
| 1   | Core `message_fee`                         | ✅ 0                                |
| 2   | Governor applies to NTT on NEAR            | ✅ No                               |
| 3   | Guardians sign a non-Portal NEAR emitter   | ✅ Yes — signed live on testnet     |
| 4   | Token storage registration                 | ✅ 0.00125 NEAR, required           |
| 5   | NEAR core verifies current Hydration VAAs  | ✅ Guardian set 7                   |
| 6   | Gas profile vs 300 TGas                    | ✅ 6–19 TGas burnt per flow         |

## 1. Core `message_fee` — 0

```
contract.wormhole_crypto.near  message_fee()  →  0
```

`publish_message` requires `attached_deposit ≥ message_fee`, so publishing is free.
`ft_on_transfer` cannot receive a NEAR deposit, and does not need to.

## 2. Governor — does not apply

`node/pkg/governor/governor.go`, `parseMsgAlreadyLocked`:

1. `vaa.IsTransfer(msg.Payload)` — only Portal transfer payloads (types 1 and 3) are considered.
2. `msg.EmitterAddress != ce.emitterAddr` → not governed. `ce.emitterAddr` is the single token-bridge
   emitter configured per chain.

An NTT message starts with `0x9945FF10`, and its emitter is our contract, not
`contract.portalbridge.near`. It fails both checks, so NEAR's $100k/day governor limit never touches
it.

**Consequence:** the NTT rate limits are the only caps on this route. Launch caps
([spec.md](spec.md#launch-caps)) are the whole safety margin, not an extra one.

## 3. Guardians sign a non-Portal emitter — yes

The core signs whatever `publish_message` is given; the only question was whether the guardians'
NEAR watcher filters by caller, and whether enough of them watch NEAR to reach quorum. Neither
blocks.

**The watcher is emitter-agnostic** (`node/pkg/watchers/near/tx_processing.go`):

- Receipts are accepted when `executor_id == wormholeAccount` — the core contract, whoever called it.
- The event must be `EVENT_JSON` with `standard: "wormhole"`, `event: "publish"`, a 32-byte emitter,
  `seq > 0`.
- The emitter is taken from the event, which the core sets to `sha256(predecessor_account_id)`
  (`contracts/wormhole/src/lib.rs`, `publish_message`).

Nothing filters on the caller.

**Quorum watches NEAR today.** The latest Portal VAA from NEAR,
`15/148410499d…fcb7/9281` (2026-09-24T01:11Z), carries **17 signatures from guardian set 7** — 17
of 19 guardians observe NEAR, against a quorum of 13. The same watcher, on the same guardians, sees
our contract's publishes.

No live VAA from a non-Portal NEAR emitter existed on mainnet (the last 500 chain-15 VAAs are all
from `sha256("contract.portalbridge.near")`; the NFT bridge has none), but nothing in the path
distinguishes one.

**Confirmed live on testnet, 2026-09-24.** The `ntt-manager` contract deployed to NEAR testnet
(`ntt-near.whm-ntt-0bugdc.testnet`) published a transfer; the Wormhole testnet guardian
(`0x13947Bd48b18E53fdAeEe77F3473391aC727C638`, set 0) signed it —
`15/34831e4dba0ea821cb7f0af0ce96f5efe4beb0db1fded12219e4329ff95a7213/1`. Same watcher code as
mainnet. The stage 6 canary repeats it on mainnet.

**Optional pre-canary check** — [`crates/near/scripts/check-emitter.sh`](../../crates/near/scripts/check-emitter.sh).
A plain account qualifies as an emitter, so no contract is needed: it registers the account,
publishes one message, and polls Wormholescan until the signed VAA appears, decoding its header.
~0.002 NEAR + gas; the VAA (chain 15, emitter `sha256(<account>)`) is accepted by nothing. Needs
`near-cli-rs` with the account's key.

```bash
crates/near/scripts/check-emitter.sh <account>          # register, publish, wait
crates/near/scripts/check-emitter.sh <account> --poll   # wait only
```

## 4. Token storage — 0.00125 NEAR, required

```
zec.omft.near  storage_balance_bounds  →  {min: 1.25e21, max: 1.25e21}   ft_metadata.decimals = 8
wrap.near      storage_balance_bounds  →  {min: 1.25e21, max: 1.25e21}   ft_metadata.decimals = 24
storage_balance_of(<unregistered>)     →  null   (both)
```

Both tokens are standard NEP-145: an unregistered account cannot receive, and registration is a flat
0.00125 NEAR. Two consequences:

- **The NTT contract registers itself** on its token at deploy, or it cannot hold custody. A
  migration step.
- **Inbound `complete` attaches ≥ 0.00125 NEAR** for a first-time recipient, plus the storage for the
  `executed[digest]` entry; the excess is refunded. In v1 the user self-redeems, so the user pays it.

## 5. NEAR core verifies current Hydration VAAs — guardian set 7

The direct test does not work: `verify_vaa` is `&self`, but calls `env::used_gas()`, which NEAR
prohibits in view calls (`HostError(ProhibitedInView { method_name: "used_gas" })`).

So the contract's own state was read instead (`view_state`, key `STATE`) and Borsh-decoded against
`struct Wormhole`:

```
guardians              LookupMap  prefix "gs"
dups                   UnorderedSet  prefix "di" / "de", 9 entries
emitters               LookupMap  prefix "e"
guardian_set_expirity  86_400 s
guardian_set_index     7
```

The latest Hydration VAA on Wormholescan (`73/…4e7b1e55…41d1/113`, 2026-09-23) is signed by guardian
set 7. The NEAR core is current.

## 6. Gas profile — 6–19 TGas burnt, far under 300

Measured in the `near-workspaces` sandbox (`crates/near/sandbox`) against the deployed mainnet code
of the core and `wrap.near`; total burnt across every receipt of the transaction:

| Flow                                               | Burnt   |
| -------------------------------------------------- | ------- |
| Outbound — `ft_transfer_call` → lock → publish     | 12 TGas |
| Outbound, publish fails → refund                   | 16 TGas |
| Inbound — `complete`, first-time recipient         | 19 TGas |
| Inbound, forged signature → deposit refunded       | 12 TGas |
| `claim`                                            | 6 TGas  |

What the contract *reserves* is higher — `ft_on_transfer` requires 50 TGas free, `complete` 85 —
because static gas is reserved per hop before it is spent. Callers should attach 150–300 TGas; the
unused part comes back, less NEAR's refund penalty.

A registering `complete` costs the caller 0.00198 NEAR beyond gas: the 0.00125 registration and
~73 bytes for the replay entry. The rest of the deposit is refunded.
