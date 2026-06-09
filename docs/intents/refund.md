# Refund Handling

## Purpose

This document defines the recommended refund and reprocessing flow for Near Intents Bridge when a 1Click / Defuse quote does not complete successfully.

It complements:

- [spec.md](./spec.md)
- [schema.md](./schema.md)

The core design goal is simple:

- refunds should return to the user's **Ethereum H160** by default
- failed quotes should be recoverable and reprocessable
- protocol custody should be avoided in V1
- refund accounting should stay separate from Basejump liquidity accounting

## Key Assumption

In the current NIR design, the 1Click origin chain is **Ethereum** and the origin asset is **native ETH**. The user pays in any Hydration asset (swapped to WETH on Hydration); the WETH is bridged Hydration → Moonbeam (XCM) → Ethereum (Wormhole TokenBridge), and `BasejumpLandingNative` pays out **native ETH** (via the `destAssetFor` WETH→`NATIVE` remap) which `IntentRouter` forwards to the quote's `depositAddress`.

That means:

- `IntentRouter` forwards native ETH on Ethereum to the quote's `depositAddress`
- `refundType = ORIGIN_CHAIN` means the refund comes back on **Ethereum** as native ETH (1Click's standard origin-asset refund behavior)
- `refundTo` should therefore be an **Ethereum** address capable of receiving native ETH

If the user starts from a Hydration-side `H160` identity, the clean default is:

- initial user address on Hydration = user `H160`
- `refundTo` on Ethereum = the same `H160` value

The address value is the same, but the refunded funds exist on **Ethereum**, not on Hydration.

## Do Not Refund To `BasejumpLanding`

`BasejumpLanding` should not be used as `refundTo`.

Why:

- it is a shared Basejump liquidity component
- it is not intent-aware
- it is not a refund vault
- mixing quote refunds into Landing would couple refund accounting with bridge liquidity accounting

Those concerns should remain separate.

## Recommended Recipient

Set:

- `refundType = ORIGIN_CHAIN`
- `refundTo = userH160` on Ethereum

This is the preferred V1 model because:

- the refund goes straight back to the user
- the protocol does not need to custody failed-flow funds
- no protocol refund vault is required
- the user becomes the final authority over retry or withdrawal decisions

## Optional Fallback Recipient

If a user-owned Ethereum refund path is not available, use:

- `refundType = ORIGIN_CHAIN`
- `refundTo = RefundController` on Ethereum

`RefundController` can be either:

- a dedicated multisig address
- a dedicated Ethereum contract

This is a fallback, not the preferred baseline. A contract is better if automated retries are desired. A multisig is acceptable for V1 manual operations.

## Information Recoverable From 1Click

If a quote fails or refunds, the status endpoint can be queried using:

- `depositAddress`
- `depositMemo`, if the quote included one

The response is expected to include:

- the original `quoteRequest`
- the original `quoteResponse`
- current `status`
- `swapDetails`
- `refundReason`
- `refundedAmount`
- origin-chain and destination-chain tx hashes

That is sufficient to recover the original destination recipient and build a replacement quote, even if local operator state is degraded.

## Failure States

The refund flow is relevant when 1Click reaches a terminal non-success state such as:

- `REFUNDED`
- `FAILED`
- `INCOMPLETE_DEPOSIT`

Recommended handling:

- `REFUNDED`: funds expected back at `refundTo`
- `FAILED`: inspect status details and treat as operator intervention required
- `INCOMPLETE_DEPOSIT`: usually operator intervention or manual user resolution

## Standard Refund Flow

1. User accepts quote.
2. Quote is requested with:
   - `refundType = ORIGIN_CHAIN`
   - `refundTo = userH160`
3. `IntentEmitter.swapAndBridge` swaps to WETH and dispatches the bridge on Hydration; the fast-path completes and `IntentRouter` forwards native ETH to the quote's `depositAddress`.
4. 1Click processes the deposit.
5. If the swap cannot complete, 1Click returns funds to `userH160` on Ethereum.
6. Operator or automation checks status using `depositAddress` and `depositMemo`.
7. The user chooses:
   - reprocess with a fresh quote
   - keep or withdraw the refunded funds on Ethereum
