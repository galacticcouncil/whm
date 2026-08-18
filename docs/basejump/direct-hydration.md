# Basejump — direct Base → Hydration

Spec for the direct corridor. Funds move on two rails between exactly two chains: an **NTT
settlement** carrying the gross amount, and an **instant message** carrying the net amount
that pays the user out of a pre-funded pool. Moonbeam, `BasejumpProxy`, `XcmTransactor`, MRL and the
TokenBridge are not part of this path.

## Scope

- Inbound only: Base → Hydration. Outbound (Hydration → EVM) is out of scope.
- Single token: EURC — which is the **only** token with a Base NTT leg, so the Base deployment is
  effectively single-token. Every other EVM-railed token hubs on Ethereum.
- Ethereum → Hydration is the same shape with different constants; it needs no new Hydration
  deployment (see [Adding a corridor](#adding-a-corridor)).

## Architecture

Three contracts, one per role. Each end is its own contract, so neither carries the other's
entrypoints.

| Contract | Chain | Role |
| --- | --- | --- |
| [`Basejump`](../../contracts/src/basejump/Basejump.sol) | Base | Source. `bridgeViaWormhole` — NTT settlement + fast-path message |
| [`BasejumpMessageReceiver`](../../contracts/src/basejump/BasejumpMessageReceiver.sol) | Hydration | Receiver. `completeTransfer` — verifies the VAA, calls the landing |
| [`BasejumpLanding`](../../contracts/src/basejump/BasejumpLanding.sol) | Hydration | Pre-funded pool. Pays the recipient, retains the fee |

`Basejump` and `BasejumpMessageReceiver` inherit
[`BasejumpCore`](../../contracts/src/basejump/BasejumpCore.sol), which owns VAA verification,
replay protection, the fee, and `_fastTrack`. `BasejumpMessageReceiver` succeeds `BasejumpProxy`:
the same receive-and-deliver role, minus the Moonbeam hop and its `XcmTransactor`.

```
Base                                             Hydration
────                                             ─────────
Basejump
  │
  ├─ SETTLEMENT (gross)                          BasejumpLanding
  │    nttManagerFor[EURC]                         ▲
  │      .transfer(gross, 73, landingDest)         │ mints asset 44
  │    → NttManager 0xd1dc3517…d89a (LOCKING)      │
  │    → guardians → mrelayer app-hydration.ts     │
  │    → NttManager 0x8dd1286a…bc4c (BURNING) ─────┘
  │
  └─ FAST (net = gross − assetFee)                Basejump (receiver)
       wormhole.publishMessage(nonce, payload, 200)   │ landing
       → guardians → mrelayer app-basejump.ts ────────┤
                                                      ▼
                                            IBasejumpLanding.transfer
                                              → DISPATCH 0x0401
                                              → currencies.transfer
                                              → recipient (AccountId32)
```

The settlement replenishes the pool the fast path just paid from. The difference between the two
legs is the fee, which accrues in the landing.

## Flow

### Source — `bridgeViaWormhole(asset, amount, recipient, data)`

1. Reject `amount == 0`; reject if `landingDest` is unset (`BasejumpLandingNotSet`).
2. Reject if `nttManagerFor[asset]` is unset (`SettlementRouteNotSet`).
3. Pull `amount` with balance-delta measurement (fee-on-transfer safe) → `actualAmount`.
4. **Settle**: `quoteDeliveryPrice(HYDRATION_CHAIN_ID, hex"00")`, `forceApprove`, then
   `INttManager.transfer{value: price}(actualAmount, HYDRATION_CHAIN_ID, landingDest)` →
   `transferSequence`.
5. **Fast-track**: `_fastTrack` publishes `abi.encode(TransferPayload)` at consistency level **200**
   → `messageSequence`.

Settlement precedes publication, and the 3-argument NTT `transfer` overload hardcodes
`shouldQueue = false`. A rate-limit breach or paused rail therefore reverts the whole call before
any message exists — a payout can never outrun its settlement.

`quoteDeliveryPrice` requires `hex"00"` (a zero-count prefix) for transceiver instructions; empty
`bytes` reverts `LengthMismatch(0,1)`.

### Receiver — `completeTransfer(vaa)`

`parseAndVerifyVM` → replay check → `authorizedEmitters[sourceChain]` → decode `TransferPayload` →
`IBasejumpLanding.transfer(sourceAsset, amount, recipient, data)`, all in one transaction.

### Landing — `transfer(sourceAsset, amount, recipient, data)`

Resolves `destAssetFor[sourceAsset]`. If the pool balance suffices, dispatches
`currencies.transfer` through the `0x0401` precompile (`currencyId = uint32(uint160(destAsset))`);
otherwise it **queues** a `PendingTransfer`. `data` is ignored — recipients are AccountId32
accounts with no callback semantics.

## Storage and admin

The two ends add different slots to `BasejumpCore`:

| Slot | Contract | Purpose |
| --- | --- | --- |
| `landingDest` | `Basejump` (Base) | settlement recipient on the destination |
| `nttManagerFor[asset]` | `Basejump` (Base) | settlement rail per asset |
| `landing` | `BasejumpMessageReceiver` (Hydration) | landing pool on *this* chain |

Setters are `onlyOwner`: `setLandingDest` and `setNttManager` on the source, `setLanding` on the
receiver, plus `setAssetFee` and `setAuthorizedEmitter` from the base contracts.

The destination chain id is the constant `HYDRATION_CHAIN_ID = 73`, not storage: `landingDest` is
a single slot, so one source deployment already serves exactly one destination and a configurable
chain id could never be changed independently of it. Retargeting means a new implementation, not a
setter call. `nttManagerFor` is per-asset because NTT managers are per-token. `tokenBridge` remains
declared in `BasejumpCore` (shared with `BasejumpProxy`, which the intents BJP variant still
references) but is initialised to `0x0` and never read on this path.

## Invariants

1. **Pool binding.** Base `landingDest` must equal `pad(receiver.landing())`. Two slots on two
   chains, and *nothing on-chain checks they agree*. If they diverge the payout pool drains while
   the other address silently accumulates gross. Steps 002 and 007 both write it from the single
   `HYDRATION_LANDING` value in one env file, so divergence needs a mid-migration edit rather than
   a mis-copied address — still verify on chain before the TC authorizes the receiver.
2. **Fail-closed settlement.** A settlement failure reverts the entire call before publication.
3. **No outbound on the receiver.** `BasejumpMessageReceiver` declares no `bridgeViaWormhole`,
   `landingDest` or `nttManagerFor`. Enforced by the compiler, not by configuration.
4. **Atomic delivery.** A landing revert rolls back `receiveMessage`, leaving `processedVaas[hash]`
   false so the relayer retries. There is no owner power to replay an arbitrary VAA —
   `BasejumpProxy.resetProcessedVaa` existed only because XCM could fail *after* the VAA was
   marked processed, a failure mode the missing hop removes.
5. **A shortfall does not revert.** Invariant 4 covers misconfiguration, not an empty pool: the
   landing queues and consumes the VAA. Nothing calls `fulfillPending()` automatically — the
   `mrelayer` keeper is what closes this. Alarm on `pendingTail - pendingHead > 0`.
6. **Corridor isolation.** The receiver authorizes exactly one emitter per source chain, and the
   legacy payload is a 4-word static encoding that the current 7-word `TransferPayload` cannot
   decode. Legacy VAAs are structurally undeliverable here.

## Configuration

| Key | Value |
| --- | --- |
| Hydration chain id / EVM chain id | `73` / `222222` |
| Hydration message core | `0x3792a6d63c31941B2805181771795D9176fA82A1` (`messageFee` 0, guardian set 7, 19 keys) |
| Base chain id | `30` |
| EURC (Base) | `0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42` |
| EURC (Hydration, asset 44) | `0x000000000000000000000000000000010000002c` |
| NTT manager (Base, LOCKING) | `0xD1dc3517732c98502b5c1ba2389AcA9E9016d89a` |
| NTT manager (Hydration, BURNING) | `0x8dd1286A29df5a2785fb638d6fb1598144cfbc4c` |
| `assetFee[EURC]` | `100000` (0.1 EURC) |
| Base TC Safe (source owner) | `0xD557AeAf1e0cB3D226BfF3B7a10C2cdA9dA081E7` |
| Hydration TC (receiver + landing owner) | `0xaa7e0000000000000000000000000000000aa7e1` |

**Rate limits** (read live): outbound 100,000 EURC per 24 h sliding window; inbound
184,467,440,737 EURC with `rateLimitDuration` 86400 — effectively unlimited. `quoteDeliveryPrice`
returns 0 on this route. Note `getCurrentInboundCapacity()` reverts on the deployed Hydration
manager; read `getInboundLimitParams(30)` instead, which returns packed `TrimmedAmount`s
(`amount = raw >> 8`, `decimals = raw & 0xff`).

## Deployment

One migration, [`basejump-base`](../../migrations/definitions/basejump-base/), covering both ends —
it replaces the MRL definition of the same name, whose record is archived as
`deployments/prod/basejump-base-mrl.json`. The landing is the existing pool `0x70e9b12c…df976`, so
nothing is discovered across chains and no address is copied by hand.

| Steps | Chain | Wallet |
| --- | --- | --- |
| `001-deploy-basejump` → `002-set-landing-dest` → `003-set-eurc-ntt-manager` → `004-set-eurc-fee` | Base | `ctx.wallet.base` (`PK`) |
| `005-deploy-message-receiver` → `006-set-emitter` → `007-set-landing` | Hydration | `ctx.wallet.hydration` (`PK_HYDRATION`) |
| `008-transfer-ownership@message-receiver` → `009-transfer-ownership@basejump` | both | — |

```
1. pnpm migrate:basejump-base                        # start to finish, ends TC/Safe-owned
2. verify invariant 1 across both chains
3. TC: landing.setAuthorizedBridge(<receiver>, true) # ← go-live switch
4. TC: landing.setAuthorizedBridge(<legacy MDA>, false)
5. relayer on  →  canary
```

Step 006 reads the source address straight from `ctx.outputs["001-deploy-basejump"]`, so the two
ends cannot be wired to different deployments — a fresh source deploy is a new Wormhole emitter,
and an env-copied address would silently authorize a stale one.

The migration does not touch the landing: it is already TC-owned, already mapped `EURC -> asset 44`
(MRL migration step 013), and already funded. That has three consequences.

**The TC call in step 3 is the go-live switch.** Until it lands, a delivered VAA reverts at
`onlyAuthorizedBridge`, `processedVaas[hash]` rolls back, and the relayer retries — so steps 1–2
are safe to run early and the corridor simply stays dark. Nothing is at risk in between.

**The legacy bridge stays authorized on that pool.** `0x10c06f41…925b51`, the MRL-era
`XcmTransactor`'s Moonbeam MDA, is still an authorized bridge from the MRL migration's step 006.
Disarming the old source with `setLandingDest(0)` stops new VAAs but does not revoke it — hence
step 4 in the same TC batch.

**Liquidity is continuous.** Reusing the pool means no funding step and no drain-and-refill window
— the balance that serves the MRL path serves the direct path unchanged.

The Hydration deployer key needs an `EVMAccounts.ContractDeployer` slot; a chopsticks fork does not
enforce this, so a fork run does not validate it.

## Test coverage

Split by what each layer can actually observe.

| Layer | Covers | Notes |
| --- | --- | --- |
| [`BasejumpNttTest`](../../contracts/test/basejump/BasejumpNttTest.sol) | fail-closed settlement, `SettlementRouteNotSet`, disarm-before-pull, delivery-price forwarding, no stale approval | mutation-checked: publishing before settling breaks it |
| [`BasejumpIntegrationTest`](../../contracts/test/integration/BasejumpIntegrationTest.sol) | source → receiver → landing, fee split, pool binding, atomicity, replay, queueing | `0x0401` is `vm.mockCall`'d, so **balances do not move here** |
| [`_probeBasejumpDelivery`](../../chopsticks/probes/_probeBasejumpDelivery.ts) | real message core, real asset-44 precompile, real `0x0401` dispatch, real balance movement, replay, shortfall | Substrate fork |

Foundry cannot execute the delivery leg: the asset-44 ERC20 and `0x0401` are Substrate runtime
precompiles, not EVM bytecode, so an EVM fork sees empty code and the landing reverts on its first
`balanceOf`. Only chopsticks runs them. The probe uses the **real deployed** core and substitutes only the
guardian *set* (via `dev_setStorage` into `EVM.AccountStorages`) so it can sign a VAA the real
`parseAndVerifyVM` accepts — the verification path itself is untouched.

## Adding a corridor

`authorizedEmitters` is keyed by source chain and Hydration has one landing, so one receiver serves
every corridor. Ethereum → Hydration needs:

1. Hydration TC: `receiver.setAuthorizedEmitter(2, pad(<eth Basejump>))` and
   `landing.setDestAsset(<eth USDC>, <hydration asset>)`.
2. A `basejump-ethereum-ntt` migration mirroring `basejump-base`'s steps 001–004 — only constants differ
   (manager `0x447b2c7485A3d6813F8197E605b10BcCD8dd8398`, USDC `0xA0b86991…eB48`, Hydration
   asset 21 `0x…0100000015`). A new source deployment is required: the Base contract is a
   Base-specific emitter wired to the Base EURC manager.
3. One entry in the relayer's route list.
4. Fund the pool.

No `setAuthorizedBridge`, so a new corridor adds no trust surface on the pool. To wire a second
corridor before the ownership handover, pause `basejump-base` before step 008 and append the extra
emitter step — the runner permits appending steps, not editing or reordering.

## Adding a token

`nttManagerFor` is per-asset, so adding a token to an existing source deployment is one owner call
— **but only if that token has an NTT manager on that same source chain.** That is the binding
constraint, and it is narrow. Live NTT legs:

| Token | Hub (locking) | Decimals | Addable to a Base deployment? | To an Ethereum one? |
| --- | --- | --- | --- | --- |
| EURC | Base | 6 | already the route | no leg |
| USDC | Ethereum | 6 | **no Base leg** | yes — one owner call |
| USDT | Ethereum | 6 | **no Base leg** | yes — one owner call |
| WBTC | Ethereum | 8 | **no Base leg** | yes — one owner call |
| DAI / sUSDS / WETH | Ethereum | 18 | **no Base leg** | blocked on the dust gate below |
| SOL / jitoSOL / PRIME | Solana | — | n/a | n/a (non-EVM source) |

So the per-asset mapping buys nothing on Base — EURC is the only Base-railed token and always will
be until someone stands up another Base NTT route. Its value is on an **Ethereum** source
deployment, where six tokens share one chain and each additional one really is a single
`setNttManager` call.

Standing up a new NTT route where none exists is not a Basejump change: it needs a manager plus
transceiver on the source chain, a burning-side manager on Hydration, bilateral `setPeer`, and a
Hydration runtime governance call `EVMAccounts.set_ntt_minter(assetId, manager)` (pallet 93, call 7)
— referendum-class. Basejump can only onboard NTT-railed tokens as fast as someone stands up NTT
routes.

**Dust gate on any token with more than 8 decimals.** NTT trims amounts to 8 decimals. EURC, USDC
and USDT are 6dp and WBTC is 8dp, so all four are exact. An 18dp asset (WETH, DAI, sUSDS) loses up
to `1e10` wei between the gross settlement leg and the net fast leg — a silent per-transfer pool
leak — and may revert `TransferAmountHasDust`. Before enabling one, either quantize `actualAmount`
to the trim granularity in `bridgeViaWormhole` or set `assetFee[asset]` at or above the maximum trim
dust. Not implemented.

**Indexer note.** `transfer_sequence` means the NTT per-manager `msgSequence` on this path, not a
chain-global TokenBridge sequence. `bjscan` keys rows on `` `init-${chain}-${transferSequence}` ``;
with one NTT-railed token per source chain the ranges do not collide, but a second token on the
same source chain makes two managers each count from ~0 and the `ON CONFLICT (id) DO UPDATE` upsert
silently merges rows. Key on `messageSequence` before token #2 — which, per the table above, means
before the first Ethereum corridor carries more than one token.
