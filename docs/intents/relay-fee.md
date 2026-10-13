# Relay Fee — sizing `maxRelayFee` and `feeRequested`

The intents path settles WETH from Hydration to Ethereum over NTT and publishes a forwarding
instruction beside it. On Ethereum a relayer calls
[`IntentReceiver.processOrder(nttVaa, instructionVaa, feeRequested)`](../../contracts/src/intents/IntentReceiver.sol),
which delivers the settlement, forwards the ETH to the deposit address, and pays itself
`feeRequested` out of the delivered amount.

Two numbers price that call, and they are produced at different times by different parties:

- **`maxRelayFee`** — a ceiling the user authorizes at `placeOrder` time, carried inside the
  guardian-signed instruction. It must be sized **before either VAA exists**, so it is a forecast.
- **`feeRequested`** — what the relayer actually claims, bounded by the ceiling. By then the call is
  fully known, so it is a measurement, not a forecast.

Everything below is about the first. The second needs no model: [`agents/relayer`](../../agents/relayer/)
runs `estimateContractGas` on the real call and prices at `maxFeePerGas`.

> A too-low `maxRelayFee` is a liveness problem, never a loss. No relayer submits, the VAA sits
> valid and replay-safe, and the relayer retries with backoff until gas falls. Funds are never at
> risk — but the order stalls, so under-sizing is the failure mode worth engineering against.

## The forecast

```
gas = 21_000                  intrinsic
    + 16·nonzero + 4·zero     calldata, derived from the envelope
    + EXEC                    execution, pinned from measurement

fee = gas × maxFeePerGas × (1 + marginBps)
```

The caller owns the margin. [`agents/intent`](../../agents/intent/) returns the estimate; the SDK
passes `marginBps=2000` for its own headroom.

The fee is always native, and only ever native: `IntentReceiver` pays it out of the ETH it delivers
(`to.call{value: feeRequested}`), so there is no asset to convert into. The settlement arrives as
WETH and is unwrapped a step earlier — same wei either way, which is why the SDK can subtract
`maxRelayFee` straight from a WETH amount.

### Calldata — derived

`processOrder` carries two VAAs, and a VAA's wire size is fixed by its framing:

```
vaaBytes(sigs, payload) = 6 + 66·sigs + 51 + payload
                          │   │         │    └── the emitter's own bytes
                          │   │         └── body header: timestamp, nonce, emitterChain,
                          │   │              emitterAddress, sequence, consistencyLevel
                          │   └── 65-byte signature + 1-byte guardian index
                          └── version, guardianSetIndex, numSignatures
```

- **NTT settlement** — 217-byte payload, fixed by the NTT transceiver message shape.
- **Instruction** — 128 bytes, literally `abi.encode(uint64, address, uint256, uint256)`.
- **`sigs`** — the live guardian quorum, `⌊2n/3⌋+1` over `getGuardianSet(getCurrentGuardianSetIndex())`.
  19 guardians today, so 13.

ABI-encoded into `processOrder(bytes,bytes,uint256)` that is `4 + 96 + (32 + pad32(1132)) +
(32 + pad32(1043))` = **2372 bytes**, which is what every observed delivery carries, to the byte.

Roughly 20% of those bytes are zero (measured) — signatures are entropy, but offsets, length words,
padded addresses and the ABI-encoded payload are not. Assuming all-nonzero instead costs +0.9% on
the total, so the split is not worth more precision than that.

> [EIP-7623](https://eips.ethereum.org/EIPS/eip-7623)'s calldata floor does not bind here: 8057
> tokens puts the floor at ~101k against ~610k actually used.

### Execution — pinned

`EXEC ≈ 560_000`. This is the part that is *not* derivable — NTT delivery through the transceiver
and manager, the rate-limiter checks, the WETH unwrap, and two native transfers. Measured across
deliveries it is remarkably stable: **555,345 four times over, and 559,674 once** (a cold-account
touch).

It changes when `IntentReceiver` or the NTT stack is upgraded, and it is not self-calibrating. The
drift alarm is free, though: the relayer estimates the real call for every order, so a pinned value
that has gone stale shows up as a gap between the two.

**Known limitation.** Signature verification lives inside this constant rather than scaling with
`sigs`, because every sample was at 13 signatures and there is no second point to fit a slope
against. On a guardian-set rotation the calldata term tracks the change and this one does not —
re-pin it if that happens.

### Gas price — what the relayer will bill, not what it will pay

`estimateFeesPerGas().maxFeePerGas`, which is the exact primitive the relayer prices with.

The distinction is the whole point, and getting it wrong is what stalls orders. The relayer **pays**
the base fee — `effectiveGasPrice` equalled it on every observed delivery, no priority tip, included
anyway. But it **charges** `maxFeePerGas`, and viem computes that as `baseFee × 1.2` via its
`baseFeeMultiplier`: the relayer's own headroom against the price moving before its transaction
lands.

Quote the base fee and the ceiling collapses onto the ask:

```
ceiling  = gas × base × 1.2      quote, then the caller's 20%
asks     = gas × base × 1.2      viem's multiplier
headroom = 0
```

Measured at −0.1%. Every order then becomes a coin flip on base-fee drift — it delivers if the base
fee happens to fall between placement and relay, and retries until it does if it rises. Pricing the
ask instead restores the caller's margin to the 20% it was meant to be.

Base fee drift over the delivery lag was 0.74×–1.71×, **median 1.01×** — a martingale, so the
current value is the best point estimate and no history improves it. That spread is what the
caller's margin is for; it is uncertainty to absorb, not bias to correct.

## What this replaced

A configured `ETH_GAS_LIMIT` constant, at 350,000 against a real 608,573–612,890 — a 1.75× shortfall
that the margin could not cover. Measured across the first orders on the NTT path, fee charged ÷
actual relayer cost ran `0.80 0.62 0.65 0.29`, with the backstop relayer absorbing the difference.
Raising it to 700,000 fixed the direction and left the number arbitrary.

## The branch a forecast cannot see

`processOrder` skips delivery when a generic NTT relayer already delivered the settlement:

```solidity
if (!transceiver.isVAAConsumed(settlement.hash)) {
    transceiver.receiveMessage(nttVaa);
}
```

That is a large saving, and it is unknowable at `placeOrder` time — the settlement does not exist
yet. The forecast always assumes the expensive branch. The relayer's own estimate sees the truth and
charges the lower amount, which is the correct division of labour: the ceiling is conservative, the
claim is exact.

## Why the fee is charged on the destination

The relayer spends gas on Ethereum and is reimbursed on Ethereum, out of the delivered amount, only
on success. It never costs the user anything on Hydration. `processOrder` is atomic — deliver,
forward, pay — so whoever did the work is the one paid, and a failed call pays nobody.

The contract cannot enforce a fee *floor*; it cannot observe gas. The floor is relayer
self-interest, and competition pushes `feeRequested` below the ceiling when gas is cheap. An
`authorizedRelayer` allowlist grants a 5-minute exclusivity window from the settlement's timestamp
before the call opens to anyone — a liveness and MEV control, not a fee surface. While the allowlist
is empty, processing is permissionless.

Relaying is racy: several relayers may build the same call, and the first to land wins. The losers
revert and eat the gas, which is a cost the observed numbers above do not include — they cover
successful deliveries only.
