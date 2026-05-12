# Near Intents Schema

## Off-chain Prelude (before any chain activity)

```
┌──────────────┐    1. getQuote(originAsset, destAsset, recipient, ...)    ┌────────────────────────┐
│ User (UI)    │ ───────────────────────────────────────────────────────►  │ Defuse / OneClick      │
│              │                                                           │ Quote API              │
│              │ ◄────────── 2. quote + depositAddress (+ memo, deadline) ─│                        │
│              │                                                           └────────────────────────┘
│              │
│              │    3. user reviews + accepts quote in UI
│              │
│              │    4. UI computes intentId =
│              │       keccak256(quoteId, depositAddress, srcAmount,
│              │                  destAsset, destRecipient, deadline, nonce)
└──────────────┘

The UI talks to OneClick directly — nintent is not in this path. The UI now holds
(intentId, depositAddress) and is ready to initiate Basejump on Hydration.

Optionally, the UI may POST the accepted quote to nintent for status tracking
(so the user can poll progress via nintent's API). This is a UX convenience, not
a protocol requirement — nintent learns the depositAddress from the on-chain
IntentForwarded event regardless.
```

## End-to-End Flow (on-chain)

```
A: Hydration            B: Moonbeam (proxy)       M: off-chain agents     C: Ethereum (1 atomic tx for fast-path)         D: Defuse / OneClick +          E: Destination chain
                                                  (mrelayer + nintent)                                                       NEAR Intents + solvers         (Zcash, BTC, NEAR, ...)
┌────────────────────┐  ┌──────────────────────┐  ┌────────────────────┐  ┌────────────────────────────────────────────┐  ┌──────────────────────────────┐  ┌────────────────────┐
│ User               │  │ BasejumpProxy        │  │ mrelayer / nintent │  │ Basejump +                                 │  │ Quote API +                  │  │ User wallet        │
│                    │  │                      │  │                    │  │ BasejumpLanding +                          │  │ deposit detection +          │  │ (Zcash address)    │
│                    │  │                      │  │                    │  │ NearIntentsRouter +                        │  │ NEAR Intents settlement +    │  │                    │
│                    │  │                      │  │                    │  │ quote depositAddress (ETH EOA/contract)    │  │ solvers                      │  │                    │
│                    │  │                      │  │                    │  │                                            │  │                              │  │                    │
│ 1. XCM USDC to     │  │                      │  │                    │  │                                            │  │                              │  │                    │
│    Moonbeam +      │─►│                      │  │                    │  │                                            │  │                              │  │                    │
│    bridgeViaWorm   │  │                      │  │                    │  │                                            │  │                              │  │                    │
│    hole(USDC,      │  │ 2. TokenBridge       │  │                    │  │                                            │  │                              │  │                    │
│    amount, ETH,    │  │    .transferTokens() │  │                    │  │                                            │  │                              │  │                    │
│    recipient =     │  │    (slow, ~13min)    │  │                    │  │                                            │  │                              │  │                    │
│    Router,         │  │    recipient =       │  │                    │  │                                            │  │                              │  │                    │
│    data = encode(  │  │    BasejumpLanding   │  │                    │  │                                            │  │                              │  │                    │
│      intentId,     │  │                      │  │                    │  │                                            │  │                              │  │                    │
│      depositAddress│  │                      │  │                    │  │                                            │  │                              │  │                    │
│    ))              │  │                      │  │                    │  │                                            │  │                              │  │                    │
└────────────────────┘  │                      │  │                    │  │                                            │  │                              │  │                    │
                        │ 3. wormhole          │  │                    │  │                                            │  │                              │  │                    │
                        │    .publishMessage() │─►│ 4. Pick up         │  │                                            │  │                              │  │                    │
                        │    payload encodes   │  │    instant VAA     │  │                                            │  │                              │  │                    │
                        │    (USDC, amount,    │  │    (~2s)           │  │                                            │  │                              │  │                    │
                        │     Router, data)    │  │                    │  │                                            │  │                              │  │                    │
                        │    finality = 200    │  │ 5. Submit VAA to   │  │ 6. Basejump.completeTransfer(vaa)          │  │                              │  │                    │
                        └──────────────────────┘  │    Ethereum        │─►│    (atomic, all-or-nothing):               │  │                              │  │                    │
                                                  │    Basejump        │  │                                            │  │                              │  │                    │
                                                  │                    │  │  → BasejumpLanding.transfer(               │  │                              │  │                    │
                                                  │                    │  │      USDC, amount, Router, data)           │  │                              │  │                    │
                                                  │                    │  │                                            │  │                              │  │                    │
                                                  │                    │  │  → Router.onBasejumpReceive(               │  │                              │  │                    │
                                                  │                    │  │      asset, amount, data)                  │  │                              │  │                    │
                                                  │                    │  │    decode (intentId, depositAddress)       │  │                              │  │                    │
                                                  │                    │  │                                            │  │                              │  │                    │
                                                  │                    │  │  → USDC.transfer(depositAddress, amount)   │  │                              │  │                    │
                                                  │                    │  │    (plain ERC20, on Ethereum)              │  │                              │  │                    │
                                                  │                    │  │                                            │  │                              │  │                    │
                                                  │                    │  │  emit IntentForwarded(                     │  │                              │  │                    │
                                                  │                    │  │    intentId, depositAddress, amount)       │  │                              │  │                    │
                                                  │                    │  │                                            │  │                              │  │                    │
                                                  │                    │  │  Reverts here roll back the whole tx;      │  │                              │  │                    │
                                                  │                    │  │  slow Basejump path still replenishes      │  │                              │  │                    │
                                                  │                    │  │  Landing's pool.                           │  │                              │  │                    │
                                                  │                    │  └────────────────────────────────────────────┘  │                              │  │                    │
                                                  │                    │                                                  │                              │  │                    │
                                                  │ 7. Observe         │◄──────────────── IntentForwarded ────────────────│                              │  │                    │
                                                  │    IntentForwarded,│                                                  │                              │  │                    │
                                                  │    capture txHash  │                                                  │                              │  │                    │
                                                  │                    │                                                  │                              │  │                    │
                                                  │ 8. submitDepositTx │                                                  │ 9. detect deposit on         │  │                    │
                                                  │    ({              │─────────────────────────────────────────────────►│    depositAddress, start     │  │                    │
                                                  │      depositAddress│                                                  │    quoted processing         │  │                    │
                                                  │      txHash        │                                                  │                              │  │                    │
                                                  │    })              │                                                  │ 10. NEAR Intents settles;    │  │                    │
                                                  │                    │                                                  │     solver claims and        │  │ 11. user receives  │
                                                  │                    │                                                  │     delivers destination     │─►│     destination    │
                                                  │                    │                                                  │     asset                    │  │     asset          │
                                                  │                    │                                                  │                              │  │                    │
                                                  │ 12. Poll quote     │◄─────────────────────────────────────────────────│                              │  │                    │
                                                  │     status; report │                                                  │                              │  │                    │
                                                  │     completion     │                                                  │                              │  │                    │
                                                  └────────────────────┘                                                  └──────────────────────────────┘  └────────────────────┘


                                                  ┌────────────────────────────────────────────────────────────────────────────────┐
                                                  │ Background — slow settlement                                                   │
                                                  │                                                                                │
                                                  │ ~13 min after step 2:                                                          │
                                                  │   Relayer redeems TokenBridge VAA → USDC lands in BasejumpLanding pool on ETH  │
                                                  │   Replenishes the pool. Independent of steps 6–12.                             │
                                                  └────────────────────────────────────────────────────────────────────────────────┘
```

## Component Relationships

```
┌──────────────────┐  basejump transport   ┌────────────────────────────────────────────────┐   plain ERC20    ┌────────────────────────────┐
│ User (Hydration) │ ────────────────────► │ BasejumpLanding ──onBasejumpReceive──► Router  │ ───────────────► │ quote.depositAddress (ETH) │
│ USDC + accepted  │ (data = (intentId,    │ (Ethereum, single atomic tx on fast-path VAA)  │ USDC transfer    │ origin-chain deposit addr  │
│ quote            │  depositAddress))     │                                                │                  └─────────────┬──────────────┘
└──────────────────┘                       └──────────────────┬─────────────────────────────┘                                │
                                                              │ emit IntentForwarded                                         │ funds present here
                                                              ▼                                                              │ once Router tx mined
                                                   ┌────────────────────┐    submitDepositTx          ┌──────────────────────▼─────┐
                                                   │ nintent agent      │ ─────────────────────────► │ Defuse / OneClick API      │
                                                   │ (off-chain)        │  ({ depositAddress,        │                            │
                                                   │                    │     txHash })              └─────────────┬──────────────┘
                                                   └────────────────────┘                                          │ quoted processing
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

The local `intentId` is the correlation key across quote acquisition, Basejump transport, router forwarding, and status monitoring:

```
                 accepted quote            Basejump VAA `data`              Router event                   submitDepositTx
                 (quoteId, depositAddr,    (intentId, depositAddress)       (IntentForwarded)              lookup parameters
                  amount, dest, deadline)            │                               │                               │
                         │                           │                               │                               │
                         ▼                           ▼                               ▼                               ▼
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

The quote's `depositAddress` is the actual origin-chain recipient on Ethereum. `intentId` is the local join key used by `nintent` and emitted in `NearIntentsRouter` events.

## Intent Lifecycle (off-chain state)

| State        | Trigger                                                                                       |
| ------------ | --------------------------------------------------------------------------------------------- |
| `quoted`     | Quote returned by `nintent` / OneClick API, including `depositAddress`                        |
| `accepted`   | User accepts quote off-chain; `nintent` stores quote details and computes `intentId`          |
| `bridging`   | `BridgeInitiated` event on Hydration, recipient = `NearIntentsRouter`, data carries quote ref |
| `forwarded`  | `IntentForwarded` event on `NearIntentsRouter` — USDC transferred to `depositAddress` on ETH  |
| `submitted`  | `OneClickService.submitDepositTx({ depositAddress, txHash })` called by `nintent`             |
| `processing` | Quote service acknowledges deposit and starts quoted execution                                |
| `fulfilled`  | Solver delivered destination asset; user reported success                                     |
| `expired`    | Quote deadline passed before deposit processing completed; operator unwinds manually          |
| `reimbursed` | (background) Basejump slow path replenished `BasejumpLanding`                                 |

## Timing

| Step                                                       | Approx. duration   |
| ---------------------------------------------------------- | ------------------ |
| Off-chain quote acquisition + user accept                  | seconds            |
| Hydration → Ethereum (Basejump fast-path + atomic forward) | ~2 min             |
| `submitDepositTx` call after router forward                | seconds            |
| Quote processing + solver fill                             | seconds to minutes |
| **Total user-perceived time**                              | **~2–5 min**       |
| Basejump slow settlement (background)                      | ~13 min            |
