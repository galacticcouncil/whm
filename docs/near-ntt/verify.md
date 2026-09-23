# NEAR NTT — Pre-implementation checks

What [spec.md](spec.md) depended on before a line of contract code was written, and what each check
found. Run 2026-09-23 against NEAR mainnet (`rpc.mainnet.near.org`, `finality: final`), Wormholescan,
and the guardian source in the local `wormhole` checkout.

| #   | Question                                   | Result                              |
| --- | ------------------------------------------ | ----------------------------------- |
| 1   | Core `message_fee`                         | ✅ 0                                |
| 2   | Governor applies to NTT on NEAR            | ✅ No                               |
| 3   | Guardians sign a non-Portal NEAR emitter   | ⚠️ Yes by source; no live precedent |
| 4   | Token storage registration                 | ✅ 0.00125 NEAR, required           |
| 5   | NEAR core verifies current Hydration VAAs  | ✅ Guardian set 7                   |
| 6   | Gas profile vs 300 TGas                    | ⏳ Sandbox, during implementation   |

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

## 3. Guardians sign a non-Portal emitter — yes by source, unproven live

`node/pkg/watchers/near/tx_processing.go`:

- Receipts are accepted when `executor_id == wormholeAccount` — the core contract, whoever called it.
- The event must be `EVENT_JSON` with `standard: "wormhole"`, `event: "publish"`, a 32-byte emitter,
  `seq > 0`.
- The emitter is taken from the event, which the core sets to `sha256(predecessor_account_id)`
  (`contracts/wormhole/src/lib.rs`, `publish_message`).

Nothing filters on the caller. But every one of the last 500 chain-15 VAAs on Wormholescan came from
one emitter, `148410499d…fcb7` = `sha256("contract.portalbridge.near")` — so there is no live
example of another NEAR emitter being signed.

**Settle it before mainnet, without a contract.** `publish_message` only requires the predecessor to
be a registered emitter, and a plain account qualifies:

```
near call contract.wormhole_crypto.near register_emitter '{"emitter":"<account>"}' \
  --accountId <account> --deposit 0.01
near call contract.wormhole_crypto.near publish_message '{"data":"deadbeef","nonce":0}' \
  --accountId <account> --gas 30000000000000
```

Then look for a chain-15 VAA from `sha256("<account>")` on Wormholescan. `publish_message` requires
≥ 10 TGas prepaid.

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

## 6. Gas profile — during implementation

Outbound is `ft_transfer_call` → `ft_on_transfer` → `publish_message` → `on_published` (→ the
token's own `ft_resolve_transfer`). Inbound is `complete` → `verify_vaa` → `on_verified` →
`storage_deposit` → `ft_transfer` → `on_unlocked`. Both must fit 300 TGas with the per-hop budgets
fixed. Measured in the `near-workspaces` sandbox against the real core wasm; the frontend and relayer
pin the results.
