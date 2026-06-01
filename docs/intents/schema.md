# Near Intents Schema

## Off-chain Prelude (before any chain activity)

```
┌──────────────┐    1. getQuote(originAsset = ETH.eth,                       ┌────────────────────────┐
│ User (UI)    │                destAsset, recipient, ...)                   │ Defuse / OneClick      │
│              │ ───────────────────────────────────────────────────────►   │ Quote API              │
│              │                                                             │                        │
│              │ ◄────────── 2. quote + depositAddress (+ memo, deadline) ───│                        │
│              │                                                             └────────────────────────┘
│              │
│              │    3. user reviews + accepts quote in UI
│              │
│              │    4. UI computes intentId =
│              │       keccak256(quoteId, depositAddress, srcAmount,
│              │                  destAsset, destRecipient, deadline, nonce)
└──────────────┘

The UI talks to OneClick directly — nintent is not in this path. The UI now holds
(intentId, depositAddress) and is ready to call BasejumpHub.bridgeAndForward
on Hydration. The user pays in WETH on Hydration; native ETH lands at depositAddress
on Ethereum.
```

## End-to-End Flow (on-chain)

```
A: Hydration                B: Snowbridge       C: Moonbeam (proxy)   M: off-chain    D: Ethereum (1 atomic tx on fast-path VAA)       E: Defuse / OneClick +     F: Destination chain
   (BasejumpHub)               transport            (BasejumpProxy)      (mrelayer +     (Basejump + BasejumpLanding +                     NEAR Intents + solvers     (Zcash, BTC, NEAR, ...)
                                                                          nintent)        NearIntentsRouter + depositAddress)
┌──────────────────────┐    ┌────────────────┐  ┌──────────────────┐  ┌────────────┐  ┌─────────────────────────────────────────────┐   ┌──────────────────────┐   ┌──────────────────┐
│ User                 │    │ Snowbridge     │  │ BasejumpProxy    │  │ mrelayer / │  │ Basejump +                                  │   │ Quote API +          │   │ User wallet      │
│                      │    │ (Hydration ⇄   │  │ (whitelist gated │  │ nintent    │  │ BasejumpLanding (native ETH pool) +         │   │ deposit detection +  │   │ (Zcash address)  │
│                      │    │  Ethereum;     │  │  msg.sender =    │  │            │  │ NearIntentsRouter (forwards native ETH) +   │   │ NEAR Intents +       │   │                  │
│                      │    │  WETH→ETH      │  │  BasejumpHubMDA) │  │            │  │ quote depositAddress (ETH EOA/contract)     │   │ solvers              │   │                  │
│                      │    │  unwrap at     │  │                  │  │            │  │                                             │   │                      │   │                  │
│                      │    │  bridge edge)  │  │                  │  │            │  │                                             │   │                      │   │                  │
│                      │    │                │  │                  │  │            │  │                                             │   │                      │   │                  │
│ 1. BasejumpHub       │    │                │  │                  │  │            │  │                                             │   │                      │   │                  │
│    .bridgeAndForward │    │                │  │                  │  │            │  │                                             │   │                      │   │                  │
│    (ethAmount,       │    │                │  │                  │  │            │  │                                             │   │                      │   │                  │
│     intentId,        │    │                │  │                  │  │            │  │                                             │   │                      │   │                  │
│     depositAddress)  │    │                │  │                  │  │            │  │                                             │   │                      │   │                  │
│                      │    │                │  │                  │  │            │  │                                             │   │                      │   │                  │
│ 2a. Snowbridge leg ──┼───►│ 2b. transfer   │  │                  │  │            │  │                                             │   │                      │   │                  │
│     WETH → ETH       │    │     (slow,     │  │                  │  │            │  │                                             │   │                      │   │                  │
│     to Basejump      │    │     ~30 min)   │  │                  │  │            │  │                                             │   │                      │   │                  │
│     Landing          │    │                │  │                  │  │            │  │                                             │   │                      │   │                  │
│                      │    │                │  │                  │  │            │  │                                             │   │                      │   │                  │
│ 2c. MRL leg ─────────┼────┼────────────────┼─►│ 3. proxy receives│  │            │  │                                             │   │                      │   │                  │
│     XCM to Moonbeam, │    │                │  │    XCM as        │  │            │  │                                             │   │                      │   │                  │
│     calls            │    │                │  │    BasejumpHub   │  │            │  │                                             │   │                      │   │                  │
│     BasejumpProxy    │    │                │  │    MDA           │  │            │  │                                             │   │                      │   │                  │
│     .bridgeVia       │    │                │  │                  │  │            │  │                                             │   │                      │   │                  │
│     Wormhole(ETH,    │    │                │  │ 4. wormhole      │  │            │  │                                             │   │                      │   │                  │
│     amount, ETH,     │    │                │  │    .publishMsg() │─►│ 5. pick    │  │                                             │   │                      │   │                  │
│     Router, data=    │    │                │  │    payload =     │  │    up      │  │                                             │   │                      │   │                  │
│     (intentId,       │    │                │  │    (ETH, amount, │  │    instant │  │                                             │   │                      │   │                  │
│     depositAddress)) │    │                │  │     Router, data)│  │    VAA     │  │                                             │   │                      │   │                  │
│                      │    │                │  │    finality=200  │  │    (~2s)   │  │                                             │   │                      │   │                  │
│ (atomic — both legs  │    │                │  │                  │  │            │  │                                             │   │                      │   │                  │
│  fire or extrinsic   │    │                │  │                  │  │            │  │                                             │   │                      │   │                  │
│  reverts)            │    │                │  │                  │  │ 6. submit  │  │ 7. Basejump.completeTransfer(vaa)           │   │                      │   │                  │
│                      │    │                │  │                  │  │    VAA to  │─►│    (atomic, all-or-nothing):                │   │                      │   │                  │
│                      │    │                │  │                  │  │    Ethereum│  │                                             │   │                      │   │                  │
│                      │    │                │  │                  │  │    Basejump│  │  → BasejumpLanding.transfer(                │   │                      │   │                  │
│                      │    │                │  │                  │  │            │  │      ETH, amount, Router, data)             │   │                      │   │                  │
│                      │    │                │  │                  │  │            │  │                                             │   │                      │   │                  │
│                      │    │                │  │                  │  │            │  │  → Router.onBasejumpReceive(                │   │                      │   │                  │
│                      │    │                │  │                  │  │            │  │      asset=ETH, amount, data) payable       │   │                      │   │                  │
│                      │    │                │  │                  │  │            │  │    decode (intentId, depositAddress)        │   │                      │   │                  │
│                      │    │                │  │                  │  │            │  │                                             │   │                      │   │                  │
│                      │    │                │  │                  │  │            │  │  → depositAddress.call{value: amount}("")   │   │                      │   │                  │
│                      │    │                │  │                  │  │            │  │    (native ETH delivered;                   │   │                      │   │                  │
│                      │    │                │  │                  │  │            │  │     no unwrap needed)                       │   │                      │   │                  │
│                      │    │                │  │                  │  │            │  │                                             │   │                      │   │                  │
│                      │    │                │  │                  │  │            │  │  emit IntentForwarded(                      │   │                      │   │                  │
│                      │    │                │  │                  │  │            │  │    intentId, depositAddress, amount)        │   │                      │   │                  │
│                      │    │                │  │                  │  │            │  │                                             │   │                      │   │                  │
│                      │    │                │  │                  │  │            │  │  Reverts here roll back the whole tx;       │   │                      │   │                  │
│                      │    │                │  │                  │  │            │  │  Snowbridge slow leg still replenishes      │   │                      │   │                  │
│                      │    │                │  │                  │  │            │  │  Landing's pool.                            │   │                      │   │                  │
│                      │    │                │  │                  │  │            │  └─────────────────────────────────────────────┘   │                      │   │                  │
│                      │    │                │  │                  │  │            │                                                    │                      │   │                  │
│                      │    │                │  │                  │  │ 8. observe │◄──────────────── IntentForwarded ───────────────── │                      │   │                  │
│                      │    │                │  │                  │  │   IntentFwd│                                                    │                      │   │                  │
│                      │    │                │  │                  │  │   capture  │                                                    │                      │   │                  │
│                      │    │                │  │                  │  │   txHash   │                                                    │                      │   │                  │
│                      │    │                │  │                  │  │            │                                                    │                      │   │                  │
│                      │    │                │  │                  │  │ 9. submit  │                                                    │ 10. detect deposit   │   │                  │
│                      │    │                │  │                  │  │  DepositTx │────────────────────────────────────────────────────►│   on depositAddress │   │                  │
│                      │    │                │  │                  │  │  ({deposit │                                                    │   start quoted       │   │                  │
│                      │    │                │  │                  │  │  Address,  │                                                    │   processing         │   │                  │
│                      │    │                │  │                  │  │  txHash}); │                                                    │                      │   │                  │
│                      │    │                │  │                  │  │            │                                                    │ 11. NEAR Intents     │   │                  │
│                      │    │                │  │                  │  │            │                                                    │     settles; solver  │   │ 12. user receives│
│                      │    │                │  │                  │  │            │                                                    │     claims and       │──►│     destination  │
│                      │    │                │  │                  │  │            │                                                    │     delivers dest    │   │     asset        │
│                      │    │                │  │                  │  │            │                                                    │     asset            │   │                  │
│                      │    │                │  │                  │  │ 13. poll   │◄─────────────────────────────────────────────────  │                      │   │                  │
│                      │    │                │  │                  │  │   quote    │                                                    │                      │   │                  │
│                      │    │                │  │                  │  │   status   │                                                    │                      │   │                  │
└──────────────────────┘    └────────────────┘  └──────────────────┘  └────────────┘                                                    └──────────────────────┘   └──────────────────┘


                            ┌────────────────────────────────────────────────────────────────────────────────┐
                            │ Background — Snowbridge slow settlement                                        │
                            │                                                                                │
                            │ ~30 min after step 2b:                                                         │
                            │   Snowbridge finalizes the Hydration → Ethereum transfer (WETH→ETH at edge).   │
                            │   Native ETH lands in BasejumpLanding pool on Ethereum, replenishing the pool  │
                            │   that the fast-path payout drew from. Independent of steps 7–13.              │
                            └────────────────────────────────────────────────────────────────────────────────┘
```

## Component Relationships

```
┌──────────────────┐  Snowbridge (WETH→ETH at edge, slow)                ┌───────────────────────────────┐
│ User (Hydration) │ ──────────────────────────────────────────────────► │ BasejumpLanding (ETH pool)    │
│ WETH + accepted  │                                                     │ on Ethereum                   │
│ quote            │                                                     └──────────────┬────────────────┘
└────────┬─────────┘                                                                    │ onBasejumpReceive
         │ BasejumpHub.bridgeAndForward(ethAmount, intentId, depositAddress)            │ (fast-path VAA)
         │                                                                              ▼
         │  ┌──────────────────────┐  MRL/XCM (no token)   ┌─────────────────┐  ┌────────────────────┐  native ETH  ┌────────────────────────────┐
         └─►│ BasejumpHub          │ ───────────────────►  │ BasejumpProxy   │  │ NearIntentsRouter  │ ───────────► │ quote.depositAddress (ETH) │
            │ (Hydration, atomic   │  msg.sender check:    │ (Moonbeam,      │  │ (Ethereum,         │  forward     │ origin-chain deposit addr  │
            │  dual-transport)     │  BasejumpHub MDA      │  publishMessage │  │  IBasejumpReceiver,│  (no unwrap) └─────────────┬──────────────┘
            │                      │  only                 │  only — no      │  │  forwards native   │                            │ funds present here
            │                      │                       │  TokenBridge    │  │  ETH to deposit    │                            │ once Router tx mined
            └──────────────────────┘                       └────────┬────────┘  └────────┬───────────┘                            ▼
                                                                    │ Wormhole VAA       │ emit IntentForwarded
                                                                    ▼                    ▼
                                                          ┌──────────────────┐   ┌────────────────────┐    submitDepositTx          ┌──────────────────────────┐
                                                          │ mrelayer (fast)  │   │ nintent agent      │ ─────────────────────────►  │ Defuse / OneClick API    │
                                                          │ submits VAA to   │   │ (off-chain)        │  ({ depositAddress,         │                          │
                                                          │ Basejump on ETH  │   │                    │     txHash })               └─────────────┬────────────┘
                                                          └──────────────────┘   └────────────────────┘                                           │ quoted processing
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

The local `intentId` is the correlation key across quote acquisition, both Hydration transports, the EVM forward, and status monitoring:

```
                 accepted quote            BasejumpHub call       Basejump VAA `data`        Router event              submitDepositTx
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

The quote's `depositAddress` is the actual origin-chain recipient on Ethereum. `intentId` is the local join key used by `nintent` and emitted by both `BasejumpHub` (`BasejumpInitiated`) on Hydration and `NearIntentsRouter` (`IntentForwarded`) on Ethereum.

## Atomicity Boundaries

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│ Hydration extrinsic (1 transaction)                                                 │
│                                                                                     │
│   BasejumpHub.bridgeAndForward(...)                                                 │
│     ├─ Snowbridge leg dispatched (WETH on Hydration → native ETH at                 │
│     │  BasejumpLanding on Ethereum, ~30 min finality)                               │
│     └─ MRL leg dispatched (XCM → Moonbeam BasejumpProxy)                            │
│                                                                                     │
│   Either both legs are dispatched, or the extrinsic reverts. No partial state.      │
│   Once dispatched, each leg has independent cross-chain finality.                   │
└─────────────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────────────┐
│ Ethereum transaction (1 transaction — fast-path VAA completion)                     │
│                                                                                     │
│   Basejump.completeTransfer(vaa)                                                    │
│     └─ BasejumpLanding.transfer(ETH, amount, Router, data)                          │
│          (native ETH paid to Router via call{value:})                               │
│          └─ Router.onBasejumpReceive(asset, amount, data) payable                   │
│               ├─ depositAddress.call{value: amount}("")                             │
│               └─ emit IntentForwarded(intentId, depositAddress, amount)             │
│                                                                                     │
│   Any revert here rolls back the entire Ethereum tx. Snowbridge slow leg is         │
│   independent — its WETH still arrives in BasejumpLanding's pool, replenishing the  │
│   pool for the next operation.                                                      │
└─────────────────────────────────────────────────────────────────────────────────────┘

Why two atomicity boundaries matter:
- Hydration atomic: nobody can trigger the fast-path payout without committing the
  matching Snowbridge replenishment. This is the protocol's anti-drain guarantee.
- Ethereum atomic: if the deposit forward fails, the fast-path payout is reverted.
  Funds are never stranded at the Router — the user has the Snowbridge replenishment
  to claim against (operationally, in V1).
```

## Intent Lifecycle (off-chain state)

| State                  | Trigger                                                                                                  |
| ---------------------- | -------------------------------------------------------------------------------------------------------- |
| `quoted`               | Quote returned by OneClick API, including `depositAddress`                                               |
| `accepted`             | User accepts quote in UI; UI computes `intentId`                                                         |
| `bridging`             | `BasejumpInitiated` event on Hydration (`BasejumpHub` extrinsic confirmed)                               |
| `forwarded`            | `IntentForwarded` event on `NearIntentsRouter` — native ETH transferred to `depositAddress` on Ethereum  |
| `submitted`            | `OneClickService.submitDepositTx({ depositAddress, txHash })` called by `nintent`                        |
| `processing`           | Quote service acknowledges deposit and starts quoted execution                                           |
| `fulfilled`            | Solver delivered destination asset; user reported success                                                |
| `expired`              | Quote deadline passed before deposit processing completed; operator unwinds manually                     |
| `replenished` (bg)     | Snowbridge slow path finalized; native ETH landed in `BasejumpLanding`'s pool                            |

## Timing

| Step                                                       | Approx. duration   |
| ---------------------------------------------------------- | ------------------ |
| Off-chain quote acquisition + user accept                  | seconds            |
| Hydration extrinsic (`BasejumpHub.bridgeAndForward`)       | one block          |
| MRL leg → Moonbeam → Wormhole VAA → Ethereum + atomic fwd  | ~2 min             |
| `submitDepositTx` call after router forward                | seconds            |
| Quote processing + solver fill                             | seconds to minutes |
| **Total user-perceived time**                              | **~2–5 min**       |
| Snowbridge slow settlement (replenishes pool, background)  | ~30 min            |
