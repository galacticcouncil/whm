# Basejump

## Abstract

A Wormhole NTT transfer takes ~13 min to reach guardian finality. Users want their tokens now.
Basejump pays them immediately out of a pre-funded pool on the destination, and lets the slow
settlement replenish that pool in the background.

Funds move on two rails between exactly two chains: an **NTT settlement** carrying the gross amount
to the pool, and an **instant message** carrying the net amount that pays the user. The difference
between the two legs is the fee, which accrues in the pool.

## Scope

- Inbound only: Ethereum → Hydration. Outbound (Hydration → EVM) is out of scope.
- Single token live: USDC. Every other Ethereum-railed token is one owner call away — see
  [Adding a token](#adding-a-token); another source chain is a corridor — see
  [Adding a corridor](#adding-a-corridor).

Design diagrams: [schema.md](schema.md). Indexing: [indexer.md](indexer.md).

## Architecture

Three contracts, one per role. Each end is its own contract, so neither carries the other's
entrypoints — the corridor is inbound-only by compiler, not by configuration.

| Contract | Chain | Role |
| --- | --- | --- |
| [`BasejumpEmitter`](../../contracts/src/basejump/BasejumpEmitter.sol) | Ethereum | Source. `bridgeViaWormhole` — NTT settlement + fast-path message |
| [`BasejumpReceiver`](../../contracts/src/basejump/BasejumpReceiver.sol) | Hydration | Receiver. `completeTransfer` — verifies the VAA, calls the landing |
| [`BasejumpLanding`](../../contracts/src/basejump/BasejumpLanding.sol) | Hydration | Pre-funded pool. Pays the recipient, retains the fee |

`BasejumpReceiver` extends [`MessageReceiver`](../../contracts/src/MessageReceiver.sol) for VAA
verification, replay protection, and the authorized-emitter check. `BasejumpEmitter` is standalone
UUPS — it has no receive path to inherit. Both implement
[`IBasejumpPayload`](../../contracts/src/basejump/interfaces/IBasejumpPayload.sol), the only thing
the two ends share.

```
Ethereum                                         Hydration
────────                                         ─────────
BasejumpEmitter
  │
  ├─ SETTLEMENT (gross)                          BasejumpLanding
  │    nttManagerFor[USDC]                         ▲
  │      .transfer(gross, 73, landing)             │ pays asset 21
  │    → NttManager 0x447b2c74…8398 (LOCKING)      │
  │    → guardians → relayer (ntt)                 │
  │    → NttManager 0xeceab645…28fc (BURNING) ─────┘
  │
  └─ FAST (net = gross − assetFee)                BasejumpReceiver
       wormhole.publishMessage(nonce, payload, 200)   │ landing
       → guardians → relayer (basejump) ──────────────┤
                                                      ▼
                                            IBasejumpLanding.transfer
                                              → DISPATCH 0x0401
                                              → currencies.transfer
                                              → recipient (AccountId32)
```

## Flow

### Source — `bridgeViaWormhole(asset, amount, recipient, data)`

Returns `(transferSequence, messageSequence)`.

1. Reject `amount == 0`; reject if `landing` is unset (`LandingNotSet`).
2. Reject if `nttManagerFor[asset]` is unset (`SettlementRouteNotSet`).
3. Pull `amount` with balance-delta measurement (fee-on-transfer safe) → `actualAmount`; reject if
   it arrives as zero (`ZeroAmountReceived`).
4. **Settle**: `quoteDeliveryPrice(DEST_CHAIN_ID, hex"00")`, `forceApprove`, then
   `INttManager.transfer{value: price}(actualAmount, DEST_CHAIN_ID, landing)` → `transferSequence`.
5. **Fast-track**: `_fastTrack` publishes `abi.encode(TransferPayload)` at consistency level
   **200** → `messageSequence`, and emits `BridgeInitiated`.

Settlement precedes publication, and the 3-argument NTT `transfer` overload hardcodes
`shouldQueue = false`. A rate-limit breach or paused rail therefore reverts the whole call before any
message exists — **a payout can never outrun its settlement.**

`msg.value` must cover `deliveryPrice + wormhole.messageFee()`: the settlement's delivery price and
the fast-path publish are both paid from it.

`quoteDeliveryPrice` requires `hex"00"` (a zero-count prefix) for transceiver instructions; empty
`bytes` reverts `LengthMismatch(0,1)`.

### Receiver — `completeTransfer(vaa)`

`parseAndVerifyVM` → replay check → `authorizedEmitters[sourceChain]` → decode `TransferPayload` →
`IBasejumpLanding.transfer(sourceAsset, amount, recipient)`, all in one transaction. `data` is not
forwarded.

### Landing — `transfer(sourceAsset, amount, recipient)`

Resolves `destAssetFor[sourceAsset]`. If the pool balance suffices, dispatches `currencies.transfer`
through the `0x0401` precompile (pallet 79, call 0; `currencyId = uint32(uint160(destAsset))`);
otherwise it **queues** a `PendingTransfer` (FIFO), drained by `fulfillPending()`.

The landing takes no `data`. The payload field exists for a future corridor whose `recipient` is a
contract needing Hydration-side action once funds land — an inbound intent. Reaching a callback
needs both the receiver and the landing upgraded first.

## Wire format

The fast-path message is `abi.encode(TransferPayload)`:

| Field | Type | Notes |
| --- | --- | --- |
| `sourceAsset` | `address` | Asset pulled on the source; the landing resolves it locally |
| `amount` | `uint256` | **Net** — gross minus `assetFee`. The settlement delivers gross to the pool |
| `recipient` | `bytes32` | AccountId32 on Hydration |
| `transferSequence` | `uint64` | The NTT manager's sequence for the settlement that replenishes this payout — the correlation key between the two rails |
| `data` | `bytes` | Opaque. Published by the emitter, dropped by the receiver; nothing on Hydration reads it |

## Storage and admin

| Slot | Contract | Purpose |
| --- | --- | --- |
| `landing` | `BasejumpEmitter` | settlement recipient on the destination (bytes32) |
| `nttManagerFor[asset]` | `BasejumpEmitter` | settlement rail, per asset |
| `assetFee[asset]` | `BasejumpEmitter` | fee withheld from the fast leg, per asset |
| `landing` | `BasejumpReceiver` | landing pool on *this* chain (bytes32) |

Setters are `onlyOwner`: `setLanding`, `setNttManager`, `setAssetFee` on the emitter; `setLanding`
and `setAuthorizedEmitter` on the receiver. The landing has `setAuthorizedBridge`, `setDestAsset`,
and `withdraw`.

The destination chain id is the constant `DEST_CHAIN_ID = HydrationConsts.WORMHOLE_CHAIN_ID` (73),
not storage: `landing` is a single slot, so one source deployment already serves exactly one
destination, and a configurable chain id could never be changed independently of it. Retargeting
means a new implementation, not a setter call. `nttManagerFor` is per-asset because NTT managers are
per-token.

## Invariants

1. **Pool binding.** The emitter's `landing` must equal `pad(receiver.landing())`. Two slots on two
   chains, and *nothing on-chain checks they agree.* If they diverge, the payout pool drains while
   the other address silently accumulates gross. Steps 002 and 007 both write it from one
   `HYDRATION_LANDING` env value, so divergence needs a mid-migration edit rather than a mis-copied
   address — still verify on chain before the pool authorizes the receiver.
2. **Fail-closed settlement.** A settlement failure reverts the whole call before publication.
3. **No outbound on the receiver.** `BasejumpReceiver` declares no `bridgeViaWormhole`, no
   `nttManagerFor`. Enforced by the compiler.
4. **Atomic delivery.** A landing revert rolls back `receiveMessage`, leaving `processedVaas[hash]`
   false so the relay retries. Because both ends of the delivery are on one chain, there is no
   failure mode where the VAA is consumed but the funds did not move — and so no owner power to
   replay a VAA is needed.
5. **A shortfall does not revert.** Invariant 4 covers misconfiguration, not an empty pool: the
   landing queues and consumes the VAA. Nothing calls `fulfillPending()` automatically. Alarm on
   `pendingTail - pendingHead > 0`.
6. **Corridor isolation.** The receiver authorizes exactly one emitter per source chain.

## Configuration

| Key | Value |
| --- | --- |
| Hydration chain id / EVM chain id | `73` / `222222` |
| Hydration message core | `0x3792a6d63c31941B2805181771795D9176fA82A1` (`messageFee` 0, guardian set 7, 19 keys) |
| Ethereum chain id | `2` |
| `BasejumpEmitter` (Ethereum) | `0xa72e2bf29c840eb93adbb9ee1aa41580f01c9944` |
| `BasejumpReceiver` (Hydration) | `0x35bf3a1b9ac564c8f66c97cea1ee410cd3f97c8a` |
| `BasejumpLanding` (Hydration) | `0x70e9b12c3b19cb5f0e59984a5866278ab69df976` (impl `0x4ea0d58a…e31f`) |
| USDC (Ethereum) | `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` |
| USDC (Hydration, asset 21) | `0x0000000000000000000000000000000100000015` |
| NTT manager (Ethereum, LOCKING) | `0x447b2c7485A3d6813F8197E605b10BcCD8dd8398` |
| NTT manager (Hydration, BURNING) | `0xEcEab64542A875C4472671D9Ed1E690cdD4e28fC` |
| `assetFee[USDC]` | `100000` (0.1 USDC) |
| Ethereum TC Safe (emitter owner) | `0xD557AeAf1e0cB3D226BfF3B7a10C2cdA9dA081E7` |
| Hydration TC (receiver + landing owner) | `0xaa7e0000000000000000000000000000000aa7e1` |

**Rate limits** (read live): outbound 100,000 USDC per 24 h sliding window. `quoteDeliveryPrice`
returns 0 on this route. If `getCurrentInboundCapacity()` reverts on the Hydration manager, read
`getInboundLimitParams(2)` instead, which returns packed `TrimmedAmount`s (`amount = raw >> 8`,
`decimals = raw & 0xff`).

## Deployment

One migration, [`basejump-ethereum`](../../migrations/definitions/basejump-ethereum/), covering both
ends; ran 2026-08-28, recorded in
[`deployments/prod/basejump-ethereum.json`](../../deployments/prod/basejump-ethereum.json). The
landing is the existing pool `0x70e9b12c…df976`, so nothing is discovered across chains and no
address is copied by hand.

| Steps | Chain | Wallet |
| --- | --- | --- |
| `001-deploy-emitter` → `002-set-landing@emitter` → `003-set-usdc-ntt-manager@emitter` → `004-set-usdc-fee@emitter` | Ethereum | `ctx.wallet.ethereum` (`PK_ETHEREUM`) |
| `005-deploy-receiver` → `006-set-emitter@receiver` → `007-set-landing@receiver` | Hydration | `ctx.wallet.hydration` (`PK_HYDRATION`) |
| `008-transfer-ownership@receiver` → `009-transfer-ownership@emitter` | both | — |

```
1. pnpm migrate:basejump-ethereum                    # start to finish, ends TC/Safe-owned
2. verify invariant 1 across both chains
3. governance on the landing: setDestAsset(USDC, asset 21), fund, setAuthorizedBridge(<receiver>, true)
                                                     # ← go-live switch — referendum #404, 2026-09-16
4. TC: upgrade the receiver when its implementation predates the current source (below)
5. relay on  →  canary
```

Step 006 reads the emitter address straight from `ctx.outputs["001-deploy-emitter"]`, so the two
ends cannot be wired to different deployments — a fresh emitter deploy is a new Wormhole emitter, and
an env-copied address would silently authorize a stale one.

The migration does not touch the landing: the pool is TC-owned, so step 3 is governance. Three
consequences:

**The landing's code must match the receiver's call.** The receiver calls the four-argument
`transfer(address,uint256,bytes32,bytes)` — `data` is the inbound-intent channel, so a recipient
contract can be told what to do with the funds — and the pool must dispatch exactly that. A pool
whose implementation does not match the current source is brought up to it with
[`basejump-landing-upgrade`](../../migrations/definitions/basejump-landing-upgrade/): it builds,
checks the artifact against the selector the live receiver calls, deploys the current
`BasejumpLanding` implementation and records the `upgradeToAndCall` calldata for the TC. Storage
layout is unchanged, so the pool balance, routes, authorizations and queue carry over. Vet it with
`_probeBasejumpLandingUpgrade.ts --impl <address>`, which enacts the TC motion on a fork and
replays the real VAAs waiting on the corridor. The `basejump` relayer can run before the motion
enacts — its retry budget spans days — but a VAA that exhausts it needs a manual replay.

**The authorization in step 3 is the go-live switch.** Until it lands, a delivered VAA reverts at
`onlyAuthorizedBridge`, `processedVaas[hash]` rolls back, and the relay retries — so steps 1–2 are
safe to run early and the corridor simply stays dark. Nothing is at risk in between.

**Previously authorized bridges stay authorized.** Disarming an old source stops new VAAs but does
not revoke its authorization on the pool — revoke it in the same governance batch.

The Hydration deployer key needs an `EVMAccounts.ContractDeployer` slot; a chopsticks fork does not
enforce this, so a fork run does not validate it.

## Relaying

Two legs, two different needs:

- **Settlement** — the NTT VAA is delivered to Hydration by the `ntt` app in
  [`agents/relayer`](../../agents/relayer/), which carries the USDC route.
- **Fast path** — the `basejump` app in [`agents/relayer`](../../agents/relayer/) subscribes to each
  corridor's emitter and submits the VAA to that corridor's receiver
  ([routes.ts](../../agents/relayer/src/apps/basejump/routes.ts)). It does not wait on the source
  tx hash, and retries for days because every failure short of a bad VAA is transient (invariants
  4 and 5), a receiver the TC has not upgraded or armed yet included. A VAA that exhausts the budget
  parks in the engine's failed queue and needs a manual replay. `fulfillPending()` still needs a
  keeper.

## Test coverage

Split by what each layer can actually observe.

| Layer | Covers | Notes |
| --- | --- | --- |
| [`BasejumpEmitterTest`](../../contracts/test/basejump/BasejumpEmitterTest.sol) | fail-closed settlement, `SettlementRouteNotSet`, disarm-before-pull, delivery-price forwarding, no stale approval | mutation-checked: publishing before settling breaks it |
| [`BasejumpLandingTest`](../../contracts/test/basejump/BasejumpLandingTest.sol) | pool accounting, queueing, `fulfillPending`, authorization | `0x0401` mocked |
| [`BasejumpIntegrationTest`](../../contracts/test/integration/BasejumpIntegrationTest.sol) | emitter → receiver → landing, fee split, pool binding, atomicity, replay, queueing | `0x0401` is `vm.mockCall`'d, so **balances do not move here** |
| [`_probeBasejumpDelivery`](../../chopsticks/probes/_probeBasejumpDelivery.ts) | real message core, real asset-44 precompile, real `0x0401` dispatch, real balance movement, replay, shortfall | Substrate fork |

Foundry cannot execute the delivery leg: the asset-44 ERC20 and `0x0401` are Substrate runtime
precompiles, not EVM bytecode, so an EVM fork sees empty code and the landing reverts on its first
`balanceOf`. Only chopsticks runs them. The probe uses the **real deployed** core and substitutes
only the guardian *set* (via `dev_setStorage` into `EVM.AccountStorages`) so it can sign a VAA the
real `parseAndVerifyVM` accepts — the verification path itself is untouched.

## Adding a corridor

**One receiver per corridor; only the landing is shared.** `authorizedEmitters` is keyed by source
chain, so a single receiver *could* serve every leg — but a shared one forces each new corridor's
migration to env-copy that receiver's address in, and turns its go-live switch into a TC call
carrying a hand-pasted emitter address. Two manual copies on the one call that arms the corridor.
A corridor that deploys its own receiver wires both ends from `ctx.outputs`, so they cannot
diverge, and does not depend on any other migration having run.

The cost is a `setAuthorizedBridge` per corridor, so a new corridor **does** add trust surface on
the pool — and the landing does not scope a bridge to an asset, so each receiver gains authority
over the whole pool. It is the same audited contract acting only on VAAs from its own authorized
emitter, so this is one more instance rather than a new kind of trust, but it is not free.

A corridor needs:

1. A migration deploying both ends: the source emitter on the source chain, and this corridor's
   receiver on Hydration. A new source deployment is required per chain — the Ethereum contract is
   an Ethereum-specific emitter wired to the Ethereum USDC manager.
2. Hydration TC, on the shared landing: `landing.setAuthorizedBridge(<this receiver>, true)` and
   `landing.setDestAsset(<source asset>, <hydration asset>)`.
   `contracts/scripts/basejump-landing/addRoute.ts` prints the calldata for both.
3. Two relayer entries: the settlement leg in `ntt/routes.ts`, and the emitter → receiver pair in
   `basejump/routes.ts`.
4. Fund the pool in the destination asset.

### Ethereum → Hydration (USDC) — live

The corridor above; see [Deployment](#deployment).

Verified on mainnet: the Ethereum USDC `NttManager` is
`0x447b2c7485A3d6813F8197E605b10BcCD8dd8398` — `token()` = USDC `0xA0b86991…eB48`, `getMode()` =
LOCKING (Ethereum is USDC's hub), `getPeer(73)` = `0xEcEab645…28fC`, and
`quoteDeliveryPrice(73, hex"00")` = 0. The Hydration side is `0xEcEab645…28fC`, mode BURNING,
`token()` = asset 21 `0x…0100000015`, `getPeer(2)` pointing back. Outbound limit 100,000 USDC/24h.
The relayer's `ntt` routes carry this settlement leg and its `basejump` routes the fast path, so
step 3 is done.

Exercised end to end on an Ethereum fork: 10 USDC in settles 10 gross to the landing and publishes
9.9 net, with `assetFee` 100,000 (0.1 USDC) retained. The settlement logs precede the fast-path
`LogMessagePublished` in the receipt, which is invariant 2 holding against the real manager.

### Arbitrum → Hydration (USDC) — blocked

No NTT leg exists. `getPeer(23)` on the Hydration USDC manager is zero; its only peer is Ethereum.
A Basejump corridor cannot settle without one, so there is no migration to write yet.

Standing one up is not a Basejump change and is the harder half: USDC's NTT hub is Ethereum
(LOCKING), so Arbitrum could only join as a **burning spoke**, which needs mint/burn authority over
Circle-issued native Arbitrum USDC. Plus a manager + transceiver on Arbitrum, bilateral `setPeer`
on both ends (the Hydration side is a TC call — the manager is owned by
`0xaa7e0000000000000000000000000000000aa7e1`), and a relayer route entry. Once the leg exists the
migration is a constants-only copy of `basejump-ethereum`.

## Adding a token

`nttManagerFor` is per-asset, so adding a token to an existing source deployment is one owner call
— **but only if that token has an NTT manager on that same source chain.** That is the binding
constraint, and it is narrow. Live NTT legs:

| Token | Hub (locking) | Decimals | Addable to the Ethereum deployment? |
| --- | --- | --- | --- |
| USDC | Ethereum | 6 | live |
| USDT | Ethereum | 6 | yes — one owner call |
| WBTC | Ethereum | 8 | yes — one owner call |
| DAI / sUSDS / WETH | Ethereum | 18 | blocked on the dust gate below |
| SOL / jitoSOL / PRIME | Solana | — | n/a (non-EVM source) |

Six tokens share the Ethereum source, so each additional one really is a single `setNttManager`
call plus a landing route.

Standing up a new NTT route where none exists is not a Basejump change: it needs a manager plus
transceiver on the source chain, a burning-side manager on Hydration, bilateral `setPeer`, and a
Hydration runtime governance call `EVMAccounts.set_ntt_minter(assetId, manager)` (pallet 93, call 7)
— referendum-class. Basejump can only onboard NTT-railed tokens as fast as someone stands up NTT
routes.

**Dust gate on any token with more than 8 decimals.** NTT trims amounts to 8 decimals. USDC and USDT
are 6dp and WBTC is 8dp, so all three are exact. An 18dp asset (WETH, DAI, sUSDS) loses up to
`1e10` wei between the gross settlement leg and the net fast leg — a silent per-transfer pool leak —
and may revert `TransferAmountHasDust`. Before enabling one, either quantize `actualAmount` to the
trim granularity in `bridgeViaWormhole` or set `assetFee[asset]` at or above the maximum trim dust.
Not implemented.

**Indexer note.** `transfer_sequence` means the NTT per-manager `msgSequence` on this path, not a
chain-global sequence. `scan` keys rows on `` `init-${chain}-${transferSequence}` ``; with one
NTT-railed token per source chain the ranges do not collide, but a second token on the same source
chain makes two managers each count from ~0 and the `ON CONFLICT (id) DO UPDATE` upsert silently
merges rows. Key on `messageSequence` before token #2 — which, per the table above, means before the
first Ethereum corridor carries more than one token.
