# Intents Schema

> Diagrams document the **deployed WTT path** (`IntentEmitterWtt` → Wormhole TokenBridge → `IntentReceiver`). The Basejump-pooled **BJP** alternative (two messages, pre-funded landing pool, `IntentRouter`) is not the deployed intents path — see [relay-fee.md](relay-fee.md) and [basejump/spec.md](../basejump/spec.md) for its shape.

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
│              │    5. UI sizes amountIn / minEthOut / maxFeeIn / maxRelayFee (see fee.md)
└──────────────┘
```

The UI talks to OneClick directly — `nintent` is not in this path. The UI now holds
`(intentId, depositAddress)` and the sizing params, and is ready to call
`IntentEmitterWtt.swapAndBridge(...)` on Hydration. The user pays in **any Hydration asset `A`**
(swapped to WETH on Hydration); **native ETH** lands at `depositAddress` on Ethereum.

## End-to-End Flow (on-chain)

The asset and the trigger travel the **same** route as a **single** Wormhole message: Hydration →
(XCM reserve-transfer) → Moonbeam MDA → `TokenBridge.transferTokensWithPayload`. There is no fast/slow
split and no pre-funded pool — the one payload-3 transfer both moves the WETH and carries the intent.

```
A: Hydration (IntentEmitterWtt)     C: Moonbeam            M: off-chain        D: Ethereum (IntentReceiver.redeem)        E: OneClick + NEAR       F: dest chain
   swap A→WETH, buy GLMR fee,          MDA + TokenBridge      (mrelayer +         unwrap WETH→ETH, pay relayer,             Intents + solvers        (ZEC/BTC/…)
   dispatch batch_all                                         quoter + nintent)   forward to depositAddress

┌────────────────────────┐  ┌──────────────────────┐  ┌────────────┐  ┌───────────────────────────────────────────┐  ┌──────────────────┐  ┌──────────────┐
│ 1. swapAndBridge(      │  │                      │  │            │  │                                           │  │                  │  │              │
│    assetIn, amountIn,  │  │                      │  │            │  │                                           │  │                  │  │              │
│    minEthOut, maxFeeIn,│  │                      │  │            │  │                                           │  │                  │  │              │
│    intentId,           │  │                      │  │            │  │                                           │  │                  │  │              │
│    depositAddress,     │  │                      │  │            │  │                                           │  │                  │  │              │
│    maxRelayFee)        │  │                      │  │            │  │                                           │  │                  │  │              │
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
│      (as MDA)          │  │     WETH.approve(TB),│  │            │  │                                           │  │                  │  │              │
│   ])                   │  │     TB.transferTokens│  │            │  │                                           │  │                  │  │              │
│                        │  │     WithPayload(     │  │            │  │                                           │  │                  │  │              │
│ (atomic — swap+dispatch│  │      WETH, ethOut,   │  │            │  │                                           │  │                  │  │              │
│  apply together or the │  │      ETH_WH_ID=2,    │  │            │  │                                           │  │                  │  │              │
│  extrinsic reverts)    │  │      IntentReceiver, │  │            │  │                                           │  │                  │  │              │
│                        │  │      nonce=0,        │  │            │  │                                           │  │                  │  │              │
│                        │  │      payload=(       │  │            │  │                                           │  │                  │  │              │
│                        │  │       intentId,      │  │            │  │                                           │  │                  │  │              │
│                        │  │       depositAddr,   │  │            │  │                                           │  │                  │  │              │
│                        │  │       maxRelayFee))] │  │            │  │                                           │  │                  │  │              │
│                        │  │                      │  │            │  │                                           │  │                  │  │              │
│                        │  │ 6. publish ONE       │  │ 7. pick up │  │                                           │  │                  │  │              │
│                        │  │    payload-3 VAA ────┼─►│  signed    │  │                                           │  │                  │  │              │
│                        │  │    (LogMessage       │  │  VAA       │  │                                           │  │                  │  │              │
│                        │  │     Published)       │  │            │  │                                           │  │                  │  │              │
│                        │  │                      │  │ 8. quoter: │  │                                           │  │                  │  │              │
│                        │  │                      │  │  size      │  │                                           │  │                  │  │              │
│                        │  │                      │  │  feeReq ≤  │  │                                           │  │                  │  │              │
│                        │  │                      │  │  maxRelay  │  │                                           │  │                  │  │              │
│                        │  │                      │  │ 9. redeem ─┼─►│ 10. IntentReceiver.redeem(vaa, feeReq):   │  │                  │  │              │
│                        │  │                      │  │   (vaa,    │  │   freshness guard → TB.completeTransfer-  │  │                  │  │              │
│                        │  │                      │  │   feeReq)  │  │   WithPayload → WETH released to receiver  │  │                  │  │              │
│                        │  │                      │  │            │  │   decode (intentId, depositAddr,           │  │                  │  │              │
│                        │  │                      │  │            │  │            maxRelayFee); feeReq ≤ ceiling  │  │                  │  │              │
│                        │  │                      │  │            │  │   WETH.withdraw → native ETH               │  │                  │  │              │
│                        │  │                      │  │            │  │   forwardAmount = amount − feeReq          │  │                  │  │              │
│                        │  │                      │  │            │  │   depositAddr.call{value: forwardAmount}   │  │                  │  │              │
│                        │  │                      │  │            │  │   pay msg.sender feeReq (if > 0)           │  │                  │  │              │
│                        │  │                      │  │            │  │   emit IntentForwarded(intentId, NATIVE,   │  │                  │  │              │
│                        │  │                      │  │            │  │     depositAddr, forwardAmount)            │  │                  │  │              │
│                        │  │                      │  │            │  │     + RelayFeePaid(intentId, relayer, fee) │  │                  │  │              │
│                        │  │                      │  │            │  │   (any revert rolls back; VAA stays        │  │                  │  │              │
│                        │  │                      │  │            │  │    redeemable for retry)                   │  │                  │  │              │
│                        │  │                      │  │            │  └───────────────────────────────────────────┘  │                  │  │              │
│                        │  │                      │  │11. observe │◄──────────────── IntentForwarded ─────────────── │                  │  │              │
│                        │  │                      │  │  IntentFwd │                                                  │                  │  │              │
│                        │  │                      │  │  capture   │                                                  │                  │  │              │
│                        │  │                      │  │  txHash    │                                                  │                  │  │              │
│                        │  │                      │  │12. submit ─┼─────────────────────────────────────────────────►│ 13. detect      │  │              │
│                        │  │                      │  │  DepositTx │                                                  │   deposit, start │  │              │
│                        │  │                      │  │  ({deposit │                                                  │   processing     │  │              │
│                        │  │                      │  │  Address,  │                                                  │ 14. NEAR Intents │  │ 15. user     │
│                        │  │                      │  │  txHash})  │                                                  │   settles;       │─►│   receives   │
│                        │  │                      │  │            │                                                  │   solver delivers│  │   dest asset │
│                        │  │                      │  │16. poll   ◄┼──────────────────────────────────────────────────│   dest asset     │  │              │
│                        │  │                      │  │   status   │                                                  │                  │  │              │
└────────────────────────┘  └──────────────────────┘  └────────────┘                                                  └──────────────────┘  └──────────────┘
```

## Component Relationships

```
┌──────────────────┐
│ User (Hydration) │  any asset A + accepted quote
└────────┬─────────┘
         │ IntentEmitterWtt.swapAndBridge(assetIn, amountIn, minEthOut, maxFeeIn, intentId, depositAddress, maxRelayFee)
         ▼
┌──────────────────────┐  XCM batch_all      ┌──────────────────────────────┐
│ IntentEmitterWtt     │ ──────────────────► │ Moonbeam MDA (emitter's      │
│ (Hydration)          │  reserve-transfer   │ sovereign acct) → as MDA:    │
│ swap A→WETH,         │  WETH+GLMR → MDA,   │ WETH.approve(TokenBridge),   │
│ buy GLMR fee         │  send→Transact      │ TB.transferTokensWithPayload │
└──────────────────────┘                     └──────────────┬───────────────┘
                                                            │ ONE payload-3 VAA
                                                            │ payload=(intentId, depositAddr, maxRelayFee)
                                                            ▼
                                          ┌────────────────────────────┐   reads feeRequested   ┌──────────────┐
                                          │ mrelayer (app-intent)      │ ◄───────────────────── │ quoter       │
                                          │ redeem(vaa, feeRequested)  │                        │ (relay fee)  │
                                          └──────────────┬─────────────┘                        └──────────────┘
                                                         │ submits VAA
                                                         ▼
                                          ┌────────────────────────────┐
                                          │ IntentReceiver (Ethereum)  │
                                          │ completeTransferWithPayload │
                                          │ → unwrap WETH → native ETH  │
                                          │ → pay relayer feeRequested  │
                                          └──────────────┬─────────────┘
                                                         │ forwardAmount native ETH (call{value:})
                                                         ▼
                                          ┌────────────────────────────┐
                                          │ quote.depositAddress (ETH) │
                                          │ origin-chain deposit addr  │
                                          └──────────────┬─────────────┘
         emit IntentForwarded                            │ funds present once redeem tx mined
                ▼                                         ▼
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

The local `intentId` is the correlation key across quote acquisition, the Hydration dispatch, the EVM redeem, and status monitoring:

```
                 accepted quote            IntentEmitter call       TokenBridge payload        IntentReceiver event      submitDepositTx
                 (quoteId, depositAddr,    (intentId,             (intentId,                 (IntentForwarded)         lookup parameters
                  amount, dest, deadline)   depositAddress)        depositAddress,                   │                          │
                         │                          │              maxRelayFee)                      │                          │
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

The quote's `depositAddress` is the actual origin-chain recipient on Ethereum. `intentId` is the local join key used by `nintent` and emitted by both `IntentEmitterWtt` (`BridgeInitiated`) on Hydration and `IntentReceiver` (`IntentForwarded`) on Ethereum. The Moonbeam `LogMessagePublished` (Wormhole emitter + sequence) links the two legs as the in-flight message.

## Atomicity Boundaries

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│ Hydration extrinsic (1 transaction)                                                 │
│                                                                                     │
│   IntentEmitterWtt.swapAndBridge(...)                                               │
│     ├─ buy xcmFee GLMR (≤ maxFeeIn) + sell rest of A → WETH (≥ minEthOut)            │
│     └─ DISPATCH batch_all([ reserve-transfer WETH+GLMR → MDA , send→Transact ])      │
│                                                                                     │
│   Swap and dispatch apply together, or the extrinsic reverts. No partial state.     │
└─────────────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────────────┐
│ Moonbeam Transact (as the emitter's MDA)                                            │
│                                                                                     │
│   Batch[ WETH.approve(TokenBridge, ethOut),                                         │
│          TokenBridge.transferTokensWithPayload(WETH, ethOut, ETH_WH_ID,             │
│            IntentReceiver, nonce=0, payload=(intentId, depositAddr, maxRelayFee)) ]  │
│                                                                                     │
│   Locks the WETH on Moonbeam and publishes ONE payload-3 VAA. No second leg, no     │
│   pool — the transfer carries its own value and is delivered on redemption.         │
└─────────────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────────────┐
│ Ethereum transaction (1 transaction — redeem)                                       │
│                                                                                     │
│   IntentReceiver.redeem(vaa, feeRequested)                                          │
│     ├─ freshness guard (parseVM + isTransferCompleted)                              │
│     ├─ TokenBridge.completeTransferWithPayload → WETH released to receiver           │
│     ├─ decode (intentId, depositAddr, maxRelayFee); require feeRequested ≤ ceiling   │
│     ├─ WETH.withdraw → native ETH; forwardAmount = amount − feeRequested             │
│     ├─ depositAddr.call{value: forwardAmount}  +  emit IntentForwarded               │
│     └─ pay msg.sender feeRequested (if > 0)  +  emit RelayFeePaid                    │
│                                                                                     │
│   Any revert here rolls back the entire Ethereum tx. The VAA is only marked         │
│   consumed on success, so a failed redeem leaves it redeemable for retry; the       │
│   WETH stays locked on Moonbeam against the unredeemed VAA. Funds never stranded.   │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

Why these boundaries matter:

- Hydration atomic: the swap and the bridge dispatch never half-apply.
- Single self-contained message: the payload-3 transfer both moves the WETH and carries the intent — there's no second leg to skip and no pool to keep solvent.
- Ethereum atomic: if the forward to `depositAddress` fails, the whole `redeem` reverts and the VAA stays redeemable; funds are never stranded at the receiver.

## Intent Lifecycle (off-chain state)

| State        | Trigger                                                                                            |
| ------------ | -------------------------------------------------------------------------------------------------- |
| `quoted`     | Quote returned by OneClick API, including `depositAddress`                                          |
| `accepted`   | User accepts quote in UI; UI computes `intentId` and sizing params                                  |
| `bridging`   | `BridgeInitiated` event on Hydration (`IntentEmitterWtt` extrinsic confirmed)                       |
| `published`  | Wormhole `LogMessagePublished` on Moonbeam — the payload-3 VAA is in flight                          |
| `forwarded`  | `IntentForwarded` event on `IntentReceiver` — native ETH transferred to `depositAddress` on Ethereum |
| `submitted`  | `OneClickService.submitDepositTx({ depositAddress, txHash })` called by `nintent`                   |
| `processing` | Quote service acknowledges deposit and starts quoted execution                                      |
| `fulfilled`  | Solver delivered destination asset; user reported success                                           |
| `expired`    | Quote deadline passed before deposit processing completed; operator unwinds manually (see refund.md) |

## Timing

| Step                                                      | Approx. duration   |
| --------------------------------------------------------- | ------------------ |
| Off-chain quote acquisition + user accept                 | seconds            |
| Hydration extrinsic (`IntentEmitterWtt.swapAndBridge`)    | one block          |
| XCM → Moonbeam → Wormhole VAA signed                      | ~1–2 min           |
| Relayer `redeem` on Ethereum (forward to depositAddress)  | one block          |
| `submitDepositTx` call after redeem                       | seconds            |
| Quote processing + solver fill                            | seconds to minutes |
| **Total user-perceived time**                             | **~2–5 min**       |
