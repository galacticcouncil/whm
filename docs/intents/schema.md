# Near Intents Schema

## Off-chain Prelude (before any chain activity)

```
┌──────────────┐    1. getQuote(originAsset = ETH.eth,                       ┌────────────────────────┐
│ User (UI)    │                destAsset, recipient, ...)                   │ Defuse / OneClick      │
│              │ ───────────────────────────────────────────────────────►    │ Quote API              │
│              │                                                             │                        │
│              │ ◄────────── 2. quote + depositAddress (+ memo, deadline) ───│                        │
│              │                                                             └────────────────────────┘
│              │
│              │    3. user reviews + accepts quote in UI
│              │
│              │    4. UI computes intentId =
│              │       keccak256(quoteId, depositAddress, srcAmount,
│              │                  destAsset, destRecipient, deadline, nonce)
│              │    5. UI sizes amountIn / minEthOut / maxFeeIn (see fee.md)
└──────────────┘
```

The UI talks to OneClick directly — `nintent` is not in this path. The UI now holds
`(intentId, depositAddress)` and the sizing params, and is ready to call
`IntentEmitter.swapAndBridge(...)` on Hydration. The user pays in **any Hydration asset `A`**
(swapped to WETH on Hydration); **native ETH** lands at `depositAddress` on Ethereum.

## End-to-End Flow (on-chain)

The asset and the trigger travel the **same** route: Hydration → (XCM reserve-transfer) →
Moonbeam MDA → `BasejumpProxy.bridgeViaWormhole`, which fires both Basejump paths — a slow
Wormhole **TokenBridge** transfer (replenishes the pool, ~13 min) and an instant fast-path VAA
(~2 min). Both originate from one Moonbeam call, so they are inherently paired and self-funding.

```
A: Hydration (IntentEmitter)        C: Moonbeam            M: off-chain     D: Ethereum (1 atomic tx on fast-path VAA)     E: OneClick + NEAR       F: dest chain
   swap A→WETH, buy GLMR fee,          MDA + BasejumpProxy    (mrelayer +      (Basejump + BasejumpLandingNative +            Intents + solvers        (ZEC/BTC/…)
   dispatch batch_all                                         nintent)         IntentRouter + depositAddress)

┌────────────────────────┐  ┌──────────────────────┐  ┌────────────┐  ┌───────────────────────────────────────────┐  ┌──────────────────┐  ┌──────────────┐
│ 1. swapAndBridge(      │  │                      │  │            │  │                                           │  │                  │  │              │
│    assetIn, amountIn,  │  │                      │  │            │  │                                           │  │                  │  │              │
│    minEthOut, maxFeeIn,│  │                      │  │            │  │                                           │  │                  │  │              │
│    intentId,           │  │                      │  │            │  │                                           │  │                  │  │              │
│    depositAddress)     │  │                      │  │            │  │                                           │  │                  │  │              │
│                        │  │                      │  │            │  │                                           │  │                  │  │              │
│ 2. _swap: buy xcmFee   │  │                      │  │            │  │                                           │  │                  │  │              │
│    GLMR (≤maxFeeIn),   │  │                      │  │            │  │                                           │  │                  │  │              │
│    sell rest A → WETH; │  │                      │  │            │  │                                           │  │                  │  │              │
│    require ethOut ≥    │  │                      │  │            │  │                                           │  │                  │  │              │
│    minEthOut           │  │                      │  │            │  │                                           │  │                  │  │              │
│                        │  │                      │  │            │  │                                           │  │                  │  │              │
│ 3. batch_all([         │  │                      │  │            │  │                                           │  │                  │  │              │
│   a. transfer_assets ──┼─►│ 4. MDA credited with │  │            │  │                                           │  │                  │  │              │
│      [GLMR,WETH]→MDA   │  │    GLMR + WETH       │  │            │  │                                           │  │                  │  │              │
│   b. send→Transact ────┼─►│ 5. as MDA: Batch[    │  │            │  │                                           │  │                  │  │              │
│      (as MDA)          │  │     WETH.approve,    │  │            │  │                                           │  │                  │  │              │
│   ])                   │  │     bridgeViaWormhole│  │            │  │                                           │  │                  │  │              │
│                        │  │     (WETH, ethOut,   │  │            │  │                                           │  │                  │  │              │
│ (atomic — swap+dispatch│  │      ETH_WH_ID=2,    │  │            │  │                                           │  │                  │  │              │
│  apply together or the │  │      Router, data=   │  │            │  │                                           │  │                  │  │              │
│  extrinsic reverts)    │  │      (intentId,      │  │            │  │                                           │  │                  │  │              │
│                        │  │       depositAddr))] │  │            │  │                                           │  │                  │  │              │
│                        │  │                      │  │            │  │                                           │  │                  │  │              │
│                        │  │ 6a. TokenBridge      │  │            │  │                                           │  │                  │  │              │
│                        │  │     .transferTokens ─┼──┼────────────┼──┼──► (slow, ~13 min) replenishes pool ─┐    │  │                  │  │              │
│                        │  │     (WETH → Landing) │  │            │  │                                       │   │  │                  │  │              │
│                        │  │ 6b. _fastTrack:      │  │            │  │                                       │   │  │                  │  │              │
│                        │  │     publishMessage  ─┼─►│ 7. pick up │  │                                       │   │  │                  │  │              │
│                        │  │     payload=(WETH,   │  │  instant   │  │                                       │   │  │                  │  │              │
│                        │  │      netAmount,      │  │  VAA (~2s) │  │                                       │   │  │                  │  │              │
│                        │  │      Router, data)   │  │            │  │                                       │   │  │                  │  │              │
│                        │  │                      │  │ 8. submit ─┼─►│ 9. Basejump.completeTransfer(vaa)     │   │  │                  │  │              │
│                        │  │                      │  │    VAA to  │  │    (atomic, all-or-nothing):          ▼   │  │                  │  │              │
│                        │  │                      │  │    Ethereum│  │  → LandingNative.transfer(            (pool)│                  │  │              │
│                        │  │                      │  │            │  │      MoonbeamWETH, netAmount,             │  │                  │  │              │
│                        │  │                      │  │            │  │      Router, data)                        │  │                  │  │              │
│                        │  │                      │  │            │  │     destAssetFor[WETH]=NATIVE →           │  │                  │  │              │
│                        │  │                      │  │            │  │     Router.call{value:netAmount}          │  │                  │  │              │
│                        │  │                      │  │            │  │  → Router.onBasejumpReceive(              │  │                  │  │              │
│                        │  │                      │  │            │  │      NATIVE, netAmount, data)             │  │                  │  │              │
│                        │  │                      │  │            │  │    decode (intentId, depositAddress)      │  │                  │  │              │
│                        │  │                      │  │            │  │  → depositAddress.call{value:netAmount}   │  │                  │  │              │
│                        │  │                      │  │            │  │  emit IntentForwarded(intentId, NATIVE,   │  │                  │  │              │
│                        │  │                      │  │            │  │    depositAddress, netAmount)             │  │                  │  │              │
│                        │  │                      │  │            │  │  (any revert rolls back; slow leg still   │  │                  │  │              │
│                        │  │                      │  │            │  │   replenishes the pool)                   │  │                  │  │              │
│                        │  │                      │  │            │  └───────────────────────────────────────────┘  │                  │  │              │
│                        │  │                      │  │ 10. observe│◄──────────────── IntentForwarded ─────────────── │                  │  │              │
│                        │  │                      │  │  IntentFwd │                                                  │                  │  │              │
│                        │  │                      │  │  capture   │                                                  │                  │  │              │
│                        │  │                      │  │  txHash    │                                                  │                  │  │              │
│                        │  │                      │  │ 11. submit ┼─────────────────────────────────────────────────►│ 12. detect      │  │              │
│                        │  │                      │  │  DepositTx │                                                  │   deposit, start │  │              │
│                        │  │                      │  │  ({deposit │                                                  │   processing     │  │              │
│                        │  │                      │  │  Address,  │                                                  │ 13. NEAR Intents │  │ 14. user     │
│                        │  │                      │  │  txHash})  │                                                  │   settles;       │─►│   receives   │
│                        │  │                      │  │            │                                                  │   solver delivers│  │   dest asset │
│                        │  │                      │  │ 15. poll  ◄┼──────────────────────────────────────────────────│   dest asset     │  │              │
│                        │  │                      │  │   status   │                                                  │                  │  │              │
└────────────────────────┘  └──────────────────────┘  └────────────┘                                                  └──────────────────┘  └──────────────┘


┌────────────────────────────────────────────────────────────────────────────────┐
│ Background — Wormhole TokenBridge slow settlement                              │
│                                                                                │
│ ~13 min after step 6a:                                                         │
│   The TokenBridge transfer finalizes on Ethereum; the canonical WETH lands in  │
│   BasejumpLandingNative, replenishing the pool the fast-path payout drew from. │
│   (For a NATIVE-mapped pool the replenishment WETH is unwrapped to ETH —        │
│    off-chain keeper or a permissionless unwrap helper.) Independent of 9–15.    │
└────────────────────────────────────────────────────────────────────────────────┘
```

## Component Relationships

```
┌──────────────────┐
│ User (Hydration) │  any asset A + accepted quote
│                  │
└────────┬─────────┘
         │ IntentEmitter.swapAndBridge(assetIn, amountIn, minEthOut, maxFeeIn, intentId, depositAddress)
         ▼
┌──────────────────────┐  XCM batch_all      ┌──────────────────────────────┐
│ IntentEmitter        │ ──────────────────► │ Moonbeam MDA (emitter's      │
│ (Hydration)          │  reserve-transfer   │ sovereign acct) → as MDA:    │
│ swap A→WETH,         │  WETH+GLMR → MDA,   │ BasejumpProxy.bridgeViaWorm- │
│ buy GLMR fee         │  send→Transact      │ hole(WETH, ethOut, …, data)  │
└──────────────────────┘                     └───────┬──────────────┬───────┘
                                          slow:      │              │   fast:
                              TokenBridge.transferTokens          _fastTrack
                              (WETH → Landing, ~13 min)           publishMessage (VAA)
                                                     │              │
                                                     ▼              ▼
                                       ┌────────────────────┐  ┌──────────────────┐
                                       │ BasejumpLandingNat │  │ mrelayer (fast)  │
                                       │ (Ethereum, ETH pool│  │ submits VAA to   │
                                       │  via destAssetFor  │◄─│ Basejump on ETH  │
                                       │  WETH→NATIVE)      │  └──────────────────┘
                                       └─────────┬──────────┘
                                                 │ call{value:} + onBasejumpReceive(NATIVE, …)
                                                 ▼
                                       ┌────────────────────┐  native ETH   ┌────────────────────────────┐
                                       │ IntentRouter (ETH, │ ────────────► │ quote.depositAddress (ETH) │
                                       │ IBasejumpReceiver) │  _forward     │ origin-chain deposit addr  │
                                       └─────────┬──────────┘               └─────────────┬──────────────┘
                                                 │ emit IntentForwarded                   │ funds present once Router tx mined
                                                 ▼                                        ▼
                                       ┌────────────────────┐  submitDepositTx  ┌──────────────────────────┐
                                       │ nintent (off-chain)│ ────────────────► │ Defuse / OneClick API    │
                                       └────────────────────┘  ({depositAddr,   └─────────────┬────────────┘
                                                                  txHash})                     │ quoted processing
                                                                                               ▼
                                                                                  ┌────────────────────────────┐
                                                                                  │ NEAR Intents + solvers     │
                                                                                  └─────────────┬──────────────┘
                                                                                                │ destination asset
                                                                                                ▼
                                                                                  ┌────────────────────────────┐
                                                                                  │ Destination wallet         │
                                                                                  │ (Zcash / BTC / SOL / ...)  │
                                                                                  └────────────────────────────┘
```

## Intent ID Threading

The local `intentId` is the correlation key across quote acquisition, the Hydration dispatch, the EVM forward, and status monitoring:

```
                 accepted quote            IntentEmitter call       Basejump VAA `data`        Router event              submitDepositTx
                 (quoteId, depositAddr,    (intentId,             (intentId,                 (IntentForwarded)         lookup parameters
                  amount, dest, deadline)   depositAddress)        depositAddress)                    │                          │
                         │                          │                       │                        │                          │
                         ▼                          ▼                       ▼                        ▼                          ▼
  intentId = keccak256(abi.encode(
               quoteId,
               depositAddress,
               srcAmount,
               destAsset,
               destRecipient,
               deadline,
               nonce
             ))
```

The quote's `depositAddress` is the actual origin-chain recipient on Ethereum. `intentId` is the local join key used by `nintent` and emitted by both `IntentEmitter` (`BridgeInitiated`) on Hydration and `IntentRouter` (`IntentForwarded`) on Ethereum.

## Atomicity Boundaries

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│ Hydration extrinsic (1 transaction)                                                 │
│                                                                                     │
│   IntentEmitter.swapAndBridge(...)                                                  │
│     ├─ buy xcmFee GLMR (≤ maxFeeIn) + sell rest of A → WETH (≥ minEthOut)            │
│     └─ DISPATCH batch_all([ reserve-transfer WETH+GLMR → MDA , send→Transact ])      │
│                                                                                     │
│   Swap and dispatch apply together, or the extrinsic reverts. No partial state.     │
└─────────────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────────────┐
│ Moonbeam Transact (as the emitter's MDA)                                            │
│                                                                                     │
│   BasejumpProxy.bridgeViaWormhole(WETH, ethOut, ETH_WH_ID, Router, data)            │
│     ├─ slow: TokenBridge.transferTokens (locks WETH, replenishes pool, ~13 min)     │
│     └─ fast: _fastTrack publishMessage (VAA, ~2 min)                                │
│                                                                                     │
│   Self-funding: the call pulls and locks the WETH it bridges, so the fast payout    │
│   always has a matching slow replenishment in flight — no caller whitelist needed.  │
└─────────────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────────────┐
│ Ethereum transaction (1 transaction — fast-path VAA completion)                     │
│                                                                                     │
│   Basejump.completeTransfer(vaa)                                                    │
│     └─ BasejumpLandingNative.transfer(MoonbeamWETH, netAmount, Router, data)        │
│          destAssetFor[WETH]=NATIVE → pay native ETH to Router via call{value:}      │
│          └─ Router.onBasejumpReceive(NATIVE, netAmount, data)                       │
│               ├─ depositAddress.call{value: netAmount}("")                          │
│               └─ emit IntentForwarded(intentId, NATIVE, depositAddress, netAmount)  │
│                                                                                     │
│   Any revert here rolls back the entire Ethereum tx. The slow TokenBridge leg is    │
│   independent — its WETH still arrives in the pool, replenishing it.                │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

Why these boundaries matter:
- Hydration atomic: the swap and the bridge dispatch never half-apply.
- Self-funding bridge: nobody can trigger a fast-path payout without locking matching WETH in the same call — this is the anti-drain guarantee (it replaces the MDA-whitelist of the earlier Snowbridge design).
- Ethereum atomic: if the deposit forward fails, the fast-path payout reverts; funds are never stranded at the Router, and the slow path still replenishes the pool.

## Intent Lifecycle (off-chain state)

| State              | Trigger                                                                                            |
| ------------------ | -------------------------------------------------------------------------------------------------- |
| `quoted`           | Quote returned by OneClick API, including `depositAddress`                                         |
| `accepted`         | User accepts quote in UI; UI computes `intentId` and sizing params                                 |
| `bridging`         | `BridgeInitiated` event on Hydration (`IntentEmitter` extrinsic confirmed)                          |
| `forwarded`        | `IntentForwarded` event on `IntentRouter` — native ETH transferred to `depositAddress` on Ethereum |
| `submitted`        | `OneClickService.submitDepositTx({ depositAddress, txHash })` called by `nintent`                  |
| `processing`       | Quote service acknowledges deposit and starts quoted execution                                     |
| `fulfilled`        | Solver delivered destination asset; user reported success                                          |
| `expired`          | Quote deadline passed before deposit processing completed; operator unwinds manually               |
| `replenished` (bg) | Wormhole TokenBridge slow path finalized; canonical WETH landed in `BasejumpLandingNative`'s pool  |

## Timing

| Step                                                       | Approx. duration   |
| ---------------------------------------------------------- | ------------------ |
| Off-chain quote acquisition + user accept                  | seconds            |
| Hydration extrinsic (`IntentEmitter.swapAndBridge`)        | one block          |
| XCM → Moonbeam → Wormhole VAA → Ethereum + atomic forward  | ~2 min             |
| `submitDepositTx` call after router forward                | seconds            |
| Quote processing + solver fill                             | seconds to minutes |
| **Total user-perceived time**                              | **~2–5 min**       |
| Wormhole TokenBridge slow settlement (replenishes pool)    | ~13 min            |
```
