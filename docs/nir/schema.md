# Near Intents Schema

## End-to-End Flow

```
A: Hydration              B: Moonbeam (proxy)         Relayer (off-chain)      C: Ethereum                D: NEAR Intents            E: Destination chain
                                                                                                                                     (Zcash, BTC, NEAR, ...)
┌──────────────────┐    ┌──────────────────────┐    ┌──────────────────┐    ┌──────────────────────┐    ┌──────────────────────┐    ┌──────────────────────┐
│ User             │    │ BasejumpProxy        │    │                  │    │ BasejumpLanding      │    │ OmniBridge           │    │ User wallet          │
│                  │    │                      │    │                  │    │ (USDC pool)          │    │ (eth lock)           │    │ (Zcash address)      │
│                  │    │                      │    │                  │    │                      │    │                      │    │                      │
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
│    Router)       │    │    recipient =       │    │                  │    │                      │    │                      │    │                      │
│                  │    │    BasejumpLanding   │    │                  │    │                      │    │                      │    │                      │
└──────────────────┘    │                      │    │                  │    │                      │    │                      │    │                      │
                        │ 3. wormhole          │    │                  │    │                      │    │                      │    │                      │
                        │    .publishMessage() │───►│ 4. Pick up       │    │                      │    │                      │    │                      │
                        │    (finality=200,    │    │    instant VAA   │    │                      │    │                      │    │                      │
                        │     ~2s)             │    │    (~2s)         │    │                      │    │                      │    │                      │
                        └──────────────────────┘    │                  │    │                      │    │                      │    │                      │
                                                    │ 5. Submit VAA    │    │                      │    │                      │    │                      │
                                                    │    to Ethereum   │───►│ 6. completeTransfer  │    │                      │    │                      │
                                                    │    Basejump      │    │    .transfer(USDC,   │    │                      │    │                      │
                                                    └──────────────────┘    │       amount,        │    │                      │    │                      │
                                                                            │       Router)        │    │                      │    │                      │
                                                                            │    → USDC lands at   │    │                      │    │                      │
                                                                            │      NearIntents     │    │                      │    │                      │
                                                                            │      Router          │    │                      │    │                      │
                                                                            └──────────────────────┘    │                      │    │                      │
                                                                                                        │                      │    │                      │
                                                    ┌──────────────────┐    ┌──────────────────────┐    │                      │    │                      │
                                                    │ nintent agent    │    │ NearIntentsRouter    │    │                      │    │                      │
                                                    │                  │    │                      │    │                      │    │                      │
                                                    │ 7. Watch USDC    │───►│ 8. forward(          │    │                      │    │                      │
                                                    │    arrival at    │    │      intentId,       │    │                      │    │                      │
                                                    │    Router        │    │      amount)         │    │                      │    │                      │
                                                    │                  │    │                      │    │                      │    │                      │
                                                    │                  │    │    USDC.approve(     │    │                      │    │                      │
                                                    │                  │    │      OmniBridge)     │    │                      │    │                      │
                                                    │                  │    │                      │    │                      │    │                      │
                                                    │                  │    │ 9. OmniBridge        │───►│ 10. Fast-transfer    │    │                      │
                                                    │                  │    │    .initTransfer(    │    │     relayer fronts   │    │                      │
                                                    │                  │    │      USDC, amount,   │    │     USDC.e to        │    │                      │
                                                    │                  │    │      serviceAcct,    │    │     serviceAcct on   │    │                      │
                                                    │                  │    │      FastFinTransfer │    │     intents.near     │    │                      │
                                                    │                  │    │       Msg{           │    │     (~seconds)       │    │                      │
                                                    │                  │    │        intentId,     │    │                      │    │                      │
                                                    │                  │    │        fee})         │    │     Slow path        │    │                      │
                                                    │                  │    └──────────────────────┘    │     reimburses       │    │                      │
                                                    │                  │                                │     relayer later    │    │                      │
                                                    │                  │                                │     (~10–20 min,     │    │                      │
                                                    │                  │                                │      background)     │    │                      │
                                                    │                  │                                │                      │    │                      │
                                                    │ 11. Wait for     │◄───────────────────────────────│                      │    │                      │
                                                    │     fast-fill    │                                │                      │    │                      │
                                                    │     credit on    │                                │                      │    │                      │
                                                    │     intents.near │                                │                      │    │                      │
                                                    │                  │                                │                      │    │                      │
                                                    │ 12. Submit       │                                │                      │    │                      │
                                                    │     signed       │                                │                      │    │                      │
                                                    │     intent to    │───────────────────────────────►│ 13. Verify intent    │    │                      │
                                                    │     intents.near │                                │     signature        │    │                      │
                                                    │                  │                                │     Debit            │    │                      │
                                                    │                  │                                │     serviceAcct      │    │                      │
                                                    │                  │                                │     USDC.e balance   │    │                      │
                                                    │                  │                                │                      │    │                      │
                                                    │                  │                                │ 14. Solver claims    │    │                      │
                                                    │                  │                                │     intent           │────┼─►15. Solver delivers │
                                                    │                  │                                │     Credit solver    │    │     ZEC to user      │
                                                    │                  │                                │     USDC.e           │    │     Zcash address    │
                                                    │                  │                                │                      │    │                      │
                                                    │ 16. Report       │◄───────────────────────────────│                      │    │                      │
                                                    │     completion   │                                │                      │    │                      │
                                                    │     to user      │                                │                      │    │                      │
                                                    └──────────────────┘                                └──────────────────────┘    └──────────────────────┘


                                                    ┌────────────────────────────────────────────────────────────────────────────────┐
                                                    │ Background — slow settlements                                                  │
                                                    │                                                                                │
                                                    │ ~13 min after step 2:                                                          │
                                                    │   Relayer redeems TokenBridge VAA → USDC lands in BasejumpLanding pool on ETH  │
                                                    │   Replenishes the pool. Independent of steps 4–16.                             │
                                                    │                                                                                │
                                                    │ ~10–20 min after step 9:                                                       │
                                                    │   OmniBridge light client finalizes on NEAR → mints nep141:eth.bridge.near     │
                                                    │   to the fast-transfer relayer. Reimburses fronted USDC.e. Independent of      │
                                                    │   steps 11–16.                                                                 │
                                                    └────────────────────────────────────────────────────────────────────────────────┘
```

## Component Relationships

```
┌──────────────────┐  basejump transport  ┌──────────────────┐  payout      ┌──────────────────────┐
│  User (Hydration)│ ───────────────────► │ BasejumpLanding  │ ───────────► │  NearIntentsRouter   │
│  USDC + signed   │                      │  (Ethereum)      │  USDC        │  (Ethereum)          │
│  intent          │                      │                  │              │                      │
└──────────────────┘                      └──────────────────┘              └──────────┬───────────┘
                                                                                       │ initTransfer
                                                                                       │ (FastFinTransferMsg)
                                                                                       ▼
                                                                            ┌──────────────────────┐
                                                                            │  OmniBridge (eth)    │
                                                                            │  locks USDC          │
                                                                            └──────────┬───────────┘
                                                                                       │ fast-fill (~sec)        ┌─────────────────────┐
                                                                                       │ slow mint (~10–20 min)  │  Fast-transfer      │
                                                                                       ▼  ◄──────────────────────│  relayer (off-chain)│
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
                  user signs                Basejump nonce               OmniBridge memo                NEAR Intents
                  intent payload            (correlation)                (cross-chain tag)              quote reference
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

## Intent Lifecycle (off-chain state)

| State        | Trigger                                                                                              |
| ------------ | ---------------------------------------------------------------------------------------------------- |
| `quoted`     | Quote returned by `nintent` API, awaiting user signature                                             |
| `signed`     | User-signed intent registered with `nintent`                                                         |
| `bridging`   | `BridgeInitiated` event on Hydration, recipient = `NearIntentsRouter`                                |
| `landed`     | `TransferExecuted` on Ethereum BasejumpLanding, funds at Router                                      |
| `forwarded`  | `IntentForwarded` event on `NearIntentsRouter` (OmniBridge `initTransfer` with `FastFinTransferMsg`) |
| `funded`     | Fast-transfer relayer credits USDC.e to `serviceAcct` on `intents.near`                              |
| `submitted`  | Intent submitted to `intents.near` by `nintent`                                                      |
| `fulfilled`  | Solver delivered destination asset; user reported success                                            |
| `expired`    | Intent deadline passed before `submitted`; operator unwinds manually                                 |
| `reimbursed` | (background) OmniBridge slow path mints USDC.e to relayer; settles fronted liquidity                 |

```

## Timing

| Step                                            | Approx. duration   |
| ----------------------------------------------- | ------------------ |
| Hydration → Ethereum (Basejump fast-path)       | ~2 min             |
| `forward` tx on Ethereum                        | seconds            |
| OmniBridge fast-transfer fill on `intents.near` | ~seconds           |
| NEAR Intents quote submission + solver fill     | seconds to minutes |
| **Total user-perceived time**                   | **~2–5 min**       |
| Basejump slow settlement (background)           | ~13 min            |
| OmniBridge slow reimbursement (background)      | ~10–20 min         |
```
