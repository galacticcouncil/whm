# Intents — Fee Breakdown

Every `swapAndBridge` call passes value across three legs (Hydration swap → Moonbeam bridge → Ethereum delivery) before it funds a OneClick quote on NEAR. Each leg charges on a different surface and is bounded by a different knob. This page is the reference for sizing `amountIn`, `minEthOut`, and `maxFeeIn`, and for understanding where the value goes.

## The stack

```
value(amountIn of A)
   −  xcmFee            (GLMR x-chain transport)      ← bought from A, bounded by maxFeeIn
   =  A available to swap → WETH                       ← swap output bounded below by minEthOut  ⇒ ethOut
   −  assetFee[WETH]    (Basejump fast-path fee)        ← charged on the Moonbeam proxy
   =  netAmount native ETH delivered to depositAddress  ← must satisfy the OneClick quote
   −  OneClick spread/fee (NEAR side)                   ← off-chain, in the quote
   =  destination asset (ZEC/BTC/…) to the user
```

So, roughly:

```
value(amountIn)  ≳  xcmFee  +  assetFee[WETH]  +  oneClick.requiredDeposit
```

## Per-leg detail

### 1. Hydration — XCM transport fee (`xcmFee`)

A fixed amount of GLMR (~`1e18`, see [`IntentEmitter.initialize`](../../contracts/src/intents/IntentEmitter.sol)) reserved for the cross-chain hop: destination arrival fee + the remote `BuyExecution` (`xcmExecutionFee`) for the Moonbeam Transact.

- **How it's paid:** in [`_swap`](../../contracts/src/intents/IntentEmitter.sol), unless `A` is already GLMR, the contract _buys_ `xcmFee` GLMR by selling `A`.
- **Caller knob — `maxFeeIn`:** the max amount of `A` the fee-buy may consume (slippage bound on the fee leg). Set it from the live `A/GLMR` price with headroom; too low → the buy reverts; it caps how much a thin/manipulated pool can extract on this leg.
- **GLMR-input path:** when `A == GLMR` the fee is withheld (`amountIn − xcmFee`), not bought, so `maxFeeIn` is ignored.
- **Operator-tunable:** `xcmFee` / `xcmExecutionFee` / gas / weight via `setXcmParams` (`onlyXcmOperator`).

### 2. Hydration — swap to WETH (`minEthOut`)

The `A` left after the fee buy is sold for WETH on the Hydration router.

- **Caller knob — `minEthOut`:** floor on `wethOut` (the WETH produced). Reverts `InsufficientOutput` below it. This is your slippage protection on the swap leg, and the amount that gets bridged is exactly `wethOut` (`ethOut`).
- Applies on **every** path, including `A == WETH` (there `wethOut = amountIn − WETH spent on the GLMR fee`).
- Only the caller's own `A` is sold — stray/donated `A` in the contract is left untouched.

### 3. Moonbeam — Basejump fast-path fee (`assetFee[WETH]`)

The bridged WETH arrives at the Moonbeam `BasejumpProxy`, which deducts a fixed per-asset fee in [`_fastTrack`](../../contracts/src/basejump/BasejumpCore.sol): `netAmount = amount − quoteFee(WETH)`, where `quoteFee(asset) = assetFee[asset]`.

- **Not a per-call param** — `assetFee[WETH]` is owner-configured on the proxy via `setAssetFee`. The UI must read it (and the live quote) to size `minEthOut` / `amountIn`.
- The fee stays in `BasejumpLanding` on the destination; the fast path pays `netAmount`, the slow Wormhole `TokenBridge.transferTokens` replenishes the pool.
- **It must also absorb Wormhole dust** (below) — `assetFee[WETH]` should be set comfortably above the dust granularity so the pool never decapitalizes.

#### Wormhole 8-decimal normalization dust

The Wormhole Token Bridge carries amounts at **8-decimal precision** ([`wormhole-solidity-sdk/.../TokenBase.sol:164,219-222`](../../contracts/dependencies/wormhole-solidity-sdk-0.1.0/src/TokenBase.sol)): on receipt the amount is re-scaled by `10^(decimals − 8)`, and the sender drops the sub-precision remainder before locking. For 18-decimal WETH that's `10^10` wei of granularity, so **up to ~`1e10` wei (`1e-8` WETH) of dust per transfer** never crosses — it accumulates on the `BasejumpProxy` side (recoverable by its owner).

Per-transfer pool delta = `(amount − dust) − netAmount` = **`assetFee[WETH] − dust`**. The pool stays solvent as long as `assetFee[WETH] ≥ dust`. Since `dust < 1e10` wei (fractions of a cent) and a sane WETH `assetFee` is far larger, this is structurally real but practically negligible — just confirm `assetFee[WETH]` is set well above `1e10` wei.

### 4. Ethereum — delivery (no fee)

`Basejump → BasejumpLanding → IntentRouter` forwards `netAmount` native ETH to the OneClick `depositAddress`. No additional fee on this leg; the landing remaps the source asset to native ETH (`destAssetFor[WETH] = NATIVE`) and `IntentRouter` forwards it.

### 5. NEAR — OneClick quote (off-chain)

The `netAmount` ETH must meet the OneClick quote's required origin deposit (`originAsset = ETH.eth`). OneClick takes its own spread/fee on the destination (B) leg; this is reflected in the quote, not charged on-chain. Size `amountIn` so `netAmount ≥ quote.requiredDeposit`.

## Relay fee — direct TokenBridge variant (`IntentReceiver`, `maxRelayFee`)

The `IntentEmitterWtt` → [`IntentReceiver`](../../contracts/src/intents/IntentReceiver.sol) path replaces legs 3–4 above with a single hop: instead of the Basejump fast-path pool + `assetFee[WETH]`, the swapped WETH is bridged straight through the Wormhole TokenBridge with a payload (`transferTokensWithPayload`), and a relayer calls `redeem(vaa, feeRequested)` on Ethereum to unwrap → native ETH → forward to `depositAddress`. There's no pre-funded pool here (Moonbeam finalizes in ~seconds, so fronting liquidity buys nothing), and so no `assetFee[WETH]`. The relay cost is paid instead.

**Destination-paid, deducted from delivery.** The relayer is reimbursed on Ethereum out of the redeemed amount — never on the source chain. Native-in, native-out, **no FX**: the redeemed asset is ETH and the relayer's cost is ETH gas, so the fee is just a haircut on `amount` before the forward, paid to `msg.sender`. The relay never costs the user anything on Hydration/Moonbeam; it's only ever charged on a _successful_ redeem.

**`maxRelayFee` — committed at source, carried in the payload.** The intent payload is `(bytes32 intentId, address depositAddress, uint256 maxRelayFee)`. `maxRelayFee` is an ETH-denominated **ceiling** the user authorizes at emit time (sized from a gas estimate + headroom, like any other fee knob). Because it rides inside the **guardian-signed VAA**, it's authenticated end-to-end — no separate signed quote, no trusted quoter service, no extra source-chain call. The relayer reads the same bytes the contract will re-decode.

**`feeRequested` — relayer names its price, bounded by the ceiling.** `redeem` enforces `feeRequested ≤ maxRelayFee` and computes `forwardAmount = amount − feeRequested` (underflow-reverts if a relayer asks for more than was delivered). The relayer sets `feeRequested` to its own gas cost + margin:

- The contract **cannot enforce a fee _floor_** — it can't observe the relayer's gas cost. The floor is enforced purely by relayer self-interest: before submitting, the relayer decodes `maxRelayFee` and `amount` from the VAA, estimates `redeem` gas locally, and only submits if `maxRelayFee ≥ estCost + margin` (and `amount > maxRelayFee`).
- Competition drives the actual fee **below** the ceiling when gas is cheap — relayers undercut on `feeRequested` rather than all grabbing `maxRelayFee`.
- **A too-low `maxRelayFee` is a liveness issue, never a loss.** If it can't cover gas, no relayer submits → the VAA simply sits unredeemed (still valid, still replay-safe) until gas drops, the operator's backstop relayer eats the cost, or it's retried with a higher ceiling. User funds are never at risk.

**Relayer mechanics.** The relayer watches the Guardians for VAAs addressed to `IntentReceiver`, parses the transfer body (same shape as `redeem`'s `parseTransferWithPayload`), and decides locally. Two gotchas: (1) it's **permissionless and racy** — multiple relayers may decode the same VAA; first `redeem` to land wins (TokenBridge marks the VAA consumed) and the losers' txs revert, so `margin` must cover revert risk; run your own backstop relayer for liveness. (2) The relayer must apply the **8-decimal Wormhole rescale** (`× 10^(decimals−8)` for 18-decimal WETH) when reading `amount`, or its profitability math is off.

> Sizing invariant (UI's job — same as `assetFee[WETH]`): the contract can't see `requiredDeposit`, so size `amountIn` such that `amount − maxRelayFee ≥ requiredDeposit`. Unlike Basejump there's no pool to decapitalize, so the 8-decimal dust just lands in `amount` and is forwarded/fee'd normally — no buffer needed.

## Sizing checklist (UI)

1. Get a live OneClick quote → `requiredDeposit` (ETH).
2. Read `assetFee[WETH]` from the proxy.
3. Target `ethOut ≥ requiredDeposit + assetFee[WETH]`; set `minEthOut` to that (with slippage tolerance).
4. Read the `A/GLMR` price; set `maxFeeIn` to cover `xcmFee` worth of `A` plus slippage headroom.
5. Choose `amountIn` so the post-fee-buy `A` swaps to `≥ minEthOut`, i.e. `value(amountIn) ≳ xcmFee + assetFee[WETH] + requiredDeposit`.

## Knobs at a glance

| Knob                         | Where                   | Set by        | Guards                                           |
| ---------------------------- | ----------------------- | ------------- | ------------------------------------------------ |
| `maxFeeIn`                   | `swapAndBridge` arg     | caller        | A spent buying the `xcmFee` GLMR (transport leg) |
| `minEthOut`                  | `swapAndBridge` arg     | caller        | WETH out of the Hydration swap (swap leg)        |
| `xcmFee` / `xcmExecutionFee` | `IntentEmitter` storage | `xcmOperator` | size of the GLMR transport reserve               |
| `assetFee[WETH]`             | `BasejumpProxy` storage | proxy owner   | Basejump fast-path fee + Wormhole dust buffer    |
| `maxRelayFee`                | intent payload (VAA)    | caller        | ceiling on the dest relay fee                    |
| `feeRequested`               | `redeem` arg            | relayer       | actual fee claimed, bounded by `maxRelayFee`     |
| `requiredDeposit`            | OneClick quote          | OneClick API  | minimum ETH the intent needs                     |
