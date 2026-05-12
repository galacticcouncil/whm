# Near Intents Schema

## End-to-End Flow

```
A: Hydration              B: Moonbeam (proxy)         mrelayer (Wormhole)       C: Ethereum (1 atomic tx for fast-path)              D: NEAR Intents
                                                                                                                                     (intents.near)             (Zcash, BTC, NEAR, ...)
┌──────────────────┐    ┌──────────────────────┐    ┌──────────────────┐    ┌──────────────────────┐    ┌──────────────────────┐    ┌──────────────────────┐
│ User             │    │ BasejumpProxy        │    │                  │    │ Basejump +           │    │ OmniBridge (eth) +   │    │ User wallet          │
│                  │    │                      │    │                  │    │ BasejumpLanding +    │    │ intents.near +       │    │ (Zcash address)      │
│                  │    │                      │    │                  │    │ NearIntentsRouter    │    │ fast-transfer relayer│    │                      │
│ 0. Quote + sign  │    │                      │    │                  │    │                      │    │                      │    │                      │
│    intent via    │    │                      │    │                  │    │                      │    │                      │    │                      │
│    nintent API   │    │                      │    │                  │    │                      │    │                      │    │                      │
│    (off-chain)   │    │                      │    │                  │    │                      │    │                      │    │                      │
│                  │    │                      │    │                  │    │                      │    │                      │    │                      │
│ 1. XCM USDC to   │    │                      │    │                  │    │                      │    │                      │    │                      │
│    Moonbeam +    │───►│                      │    │                  │    │                      │    │                      │    │                      │
│    bridgeViaWorm │    │                      │    │                  │    │                      │    │                      │    │                      │
│    hole(USDC,    │    │ 2. TokenBridge       │    │                  │    │                      │    │                      │    │                      │
│    amount, ETH,  │    │    .transferTokens() │    │                  │    │                      │    │                      │    │                      │
│    recipient =   │    │    (slow, ~13min)    │    │                  │    │                      │    │                      │    │                      │
│    Router,       │    │    recipient =       │    │                  │    │                      │    │                      │    │                      │
│    data=intentId)│    │    BasejumpLanding   │    │                  │    │                      │    │                      │    │                      │
└──────────────────┘    │                      │    │                  │    │                      │    │                      │    │                      │
                        │ 3. wormhole          │    │                  │    │                      │    │                      │    │                      │
                        │    .publishMessage() │───►│ 4. Pick up       │    │                      │    │                      │    │                      │
                        │    payload encodes   │    │    instant VAA   │    │                      │    │                      │    │                      │
                        │    (USDC, amount,    │    │    (~2s)         │    │                      │    │                      │    │                      │
                        │     Router, data)    │    │                  │    │                      │    │                      │    │                      │
                        │    finality=200      │    │ 5. Submit VAA    │    │ 6. completeTransfer  │    │                      │    │                      │
                        └──────────────────────┘    │    to Ethereum   │───►│    (vaa)             │    │                      │    │                      │
                                                    │    Basejump      │    │                      │    │                      │    │                      │
                                                    └──────────────────┘    │  → Landing.transfer( │    │                      │    │                      │
                                                                            │     USDC, amount,    │    │                      │    │                      │
                                                                            │     Router, data)    │    │                      │    │                      │
                                                                            │                      │    │                      │    │                      │
                                                                            │  → Router            │    │                      │    │                      │
                                                                            │    .onBasejumpReceive│    │                      │    │                      │
                                                                            │    decode intentId   │    │                      │    │                      │
                                                                            │    approve OmniBridge│    │                      │    │                      │
                                                                            │                      │    │                      │    │                      │
                                                                            │  → OmniBridge        │    │                      │    │                      │
                                                                            │    .initTransfer(    │───►│ 7. Fast-transfer     │    │                      │
                                                                            │     USDC, amount,    │    │    relayer fronts    │    │                      │
                                                                            │     serviceAcct,     │    │    USDC.e to         │    │                      │
                                                                            │     FastFinTransfer  │    │    serviceAcct on    │    │                      │
                                                                            │      Msg{intentId,   │    │    intents.near      │    │                      │
                                                                            │       fee})          │    │    (~seconds)        │    │                      │
                                                                            │                      │    │                      │    │                      │
                                                                            │  emit                │    │    Slow path         │    │                      │
                                                                            │  IntentForwarded(    │    │    reimburses        │    │                      │
                                                                            │   intentId, amount)  │    │    relayer later     │    │                      │
                                                                            │                      │    │    (~10–20 min,      │    │                      │
                                                                            │  Reverts here roll   │    │     background)      │    │                      │
                                                                            │  back the whole tx;  │    │                      │    │                      │
                                                                            │  slow Basejump path  │    │                      │    │                      │
                                                                            │  still replenishes   │    │                      │    │                      │
                                                                            │  Landing's pool.     │    │                      │    │                      │
                                                                            └──────────────────────┘    │                      │    │                      │
                                                                                                        │                      │    │                      │
                                                    ┌──────────────────┐                                │                      │    │                      │
                                                    │ nintent agent    │                                │                      │    │                      │
                                                    │ (off-chain,      │                                │                      │    │                      │
                                                    │  NEAR-side only) │                                │                      │    │                      │
                                                    │                  │                                │                      │    │                      │
                                                    │ 8. Watch         │◄──── IntentForwarded ─────────-│                      │    │                      │
                                                    │    Router events │                                │                      │    │                      │
                                                    │                  │                                │                      │    │                      │
                                                    │ 9. Wait for      │◄──────────────────────────────-│                      │    │                      │
                                                    │    fast-fill     │                                │                      │    │                      │
                                                    │    credit on     │                                │                      │    │                      │
                                                    │    intents.near  │                                │                      │    │                      │
                                                    │                  │                                │                      │    │                      │
                                                    │ 10. Submit       │                                │  11. Verify intent   │    │                      │
                                                    │     signed       │───────────────────────────────►│     signature        │    │                      │
                                                    │     intent to    │                                │     Debit            │    │                      │
                                                    │     intents.near │                                │     serviceAcct      │    │                      │
                                                    │                  │                                │     USDC.e balance   │    │                      │
                                                    │                  │                                │                      │    │                      │
                                                    │                  │                                │ 12. Solver claims    │    │                      │
                                                    │                  │                                │     intent           │────┼─►13. Solver delivers │
                                                    │                  │                                │     Credit solver    │    │     ZEC to user      │
                                                    │                  │                                │     USDC.e           │    │     Zcash address    │
                                                    │                  │                                │                      │    │                      │
                                                    │ 14. Report       │◄──────────────────────────────-│                      │    │                      │
                                                    │     completion   │                                │                      │    │                      │
                                                    │     to user      │                                │                      │    │                      │
                                                    └──────────────────┘                                └──────────────────────┘    └──────────────────────┘


                                                    ┌────────────────────────────────────────────────────────────────────────────────┐
                                                    │ Background — slow settlements                                                  │
                                                    │                                                                                │
                                                    │ ~13 min after step 2:                                                          │
                                                    │   Relayer redeems TokenBridge VAA → USDC lands in BasejumpLanding pool on ETH  │
                                                    │   Replenishes the pool. Independent of steps 6–14.                             │
                                                    │                                                                                │
                                                    │ ~10–20 min after step 7:                                                       │
                                                    │   OmniBridge light client finalizes on NEAR → mints nep141:eth.bridge.near     │
                                                    │   to the fast-transfer relayer. Reimburses fronted USDC.e. Independent of      │
                                                    │   steps 9–14.                                                                  │
                                                    └────────────────────────────────────────────────────────────────────────────────┘
```

## Component Relationships

```
┌──────────────────┐  basejump transport  ┌──────────────────────────────────────────────┐
│  User (Hydration)│ ───────────────────► │ BasejumpLanding ──onBasejumpReceive──► Router│
│  USDC + signed   │   (data = intentId)  │ (Ethereum, single atomic tx on fast-path VAA)│
│  intent          │                      │                                              │
└──────────────────┘                      └────────────────────┬─────────────────────────┘
                                                               │ initTransfer
                                                               │ (FastFinTransferMsg{intentId,fee})
                                                               ▼
                                                    ┌──────────────────────┐
                                                    │  OmniBridge (eth)    │
                                                    │  locks USDC          │
                                                    └──────────┬───────────┘
                                                               │ fast-fill (~sec)                                ┌─────────────────────┐
                                                               │ slow mint (~10–20 min)                          │  Fast-transfer      │
                                                               ▼  ◄──────────────────────------------------------│  relayer (off-chain)│
┌──────────────────┐  signed intent       ┌──────────────────┐  fulfill     ┌──────────────────────┐             │  fronts USDC.e,     │
│  Destination     │ ◄─────── ZEC ──────  │   Solver         │ ◄──────────  │  intents.near        │  ◄──────────│  reimbursed by      │
│  chain (Zcash)   │                      │   (NEAR Intents) │   USDC.e     │  serviceAcct balance │             │  slow OmniBridge    │
└──────────────────┘                      └──────────────────┘              └──────────────────────┘             └─────────────────────┘
                                                  ▲
                                                  │ submitted by
                                                  │
                                          ┌──────────────────┐
                                          │  nintent agent   │
                                          │  (off-chain)     │
                                          └──────────────────┘
```

## Intent ID Threading

The same `keccak256` hash links every step:

```
                  user signs                Basejump VAA `data`          OmniBridge memo                NEAR Intents
                  intent payload            (end-to-end carry)           (cross-chain tag)              quote reference
                       │                          │                            │                              │
                       ▼                          ▼                            ▼                              ▼
   intentId  =  keccak256(abi.encode(
                  user,           // bytes32 — Hydration AccountId32
                  srcAmount,      // uint256 — USDC, 6 decimals
                  destChain,      // uint16  — NEAR Intents chain enum (Zcash, BTC, NEAR, SOL, ...)
                  destAsset,      // bytes32 — destination asset id
                  destRecipient,  // bytes   — destination address (Zcash transparent/shielded, BTC, ...)
                  minOut,         // uint256 — slippage floor
                  deadline,       // uint64  — unix ms
                  nonce           // uint64  — per-user
                ))
```

The user passes `intentId` as the Basejump `data` field on Hydration. It travels through the VAA payload into `BasejumpLanding.transfer(..., data)`, is decoded inside `NearIntentsRouter.onBasejumpReceive`, and is reused verbatim as the `FastFinTransferMsg.intentId` on OmniBridge. nintent recognizes it via `IntentForwarded` events.

## Intent Lifecycle (off-chain state)

| State        | Trigger                                                                                             |
| ------------ | --------------------------------------------------------------------------------------------------- |
| `quoted`     | Quote returned by `nintent` API, awaiting user signature                                            |
| `signed`     | User-signed intent registered with `nintent`                                                        |
| `bridging`   | `BridgeInitiated` event on Hydration, recipient = `NearIntentsRouter`, data = `intentId`            |
| `forwarded`  | `IntentForwarded` event on `NearIntentsRouter` — atomic with `BasejumpLanding.transfer` on Ethereum |
| `funded`     | Fast-transfer relayer credits USDC.e to `serviceAcct` on `intents.near`                             |
| `submitted`  | Intent submitted to `intents.near` by `nintent`                                                     |
| `fulfilled`  | Solver delivered destination asset; user reported success                                           |
| `expired`    | Intent deadline passed before `submitted`; operator unwinds manually via reverse Basejump           |
| `reimbursed` | (background) OmniBridge slow path mints USDC.e to relayer; settles fronted liquidity                |

```

## Timing

| Step                                                          | Approx. duration   |
| ------------------------------------------------------------- | ------------------ |
| Hydration → Ethereum (Basejump fast-path + atomic forward)    | ~2 min             |
| OmniBridge fast-transfer fill on `intents.near`               | ~seconds           |
| NEAR Intents quote submission + solver fill                   | seconds to minutes |
| **Total user-perceived time**                                 | **~2–5 min**       |
| Basejump slow settlement (background)                         | ~13 min            |
| OmniBridge slow reimbursement (background)                    | ~10–20 min         |
```
