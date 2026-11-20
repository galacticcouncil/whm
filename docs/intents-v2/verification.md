# VERIFICATION — Intents v2

What has been checked live for the v2 design ([spec.md](spec.md)), and what is still open.

## Open

**Refunds.** Neither 1Click refunding `A` (a swap that does not fill) nor the router's post-deadline
refund has been run. Also open: the ownership handover and alerting ([plan.md §5](plan.md#5-gates)),
and the UTXO payout route ([payout.md](payout.md#unverified)).

## Verified — the deployment, end to end

All on mainnet, 2026-11-19, every stage visible in scan (`/v2/trade/<auth_path>`):

| Run            | Entry                                     | Orders      | Outcome                                                          |
| -------------- | ----------------------------------------- | ----------- | ---------------------------------------------------------------- |
| canary         | `dispatch`, WETH held by the caller       | 233         | forwarded, swapped, delivered to Zcash                           |
| swap alpha     | ICE swap: 3.7 HOLLAR → WETH               | 237         | 0.00203883 WETH bridged; 366,048 zat delivered, 294,048 received |
| TWAP alpha     | ICE `Dca`: 3 tranches every 150 blocks    | 238–240     | ~0.0009 ETH each, one batched delivery                           |

- **ICE forward** works for swaps and TWAPs, inside `execute`'s 2M gas. `assetIn` is the asset's EVM
  address: its precompile, or for an ERC20-type asset (HOLLAR, 222) its contract.
- **The pass-through.** A standing 1Click quote (ANY_INPUT, `1cs_v1:any` → `1cs_v1:original`,
  recipient and refundTo `A`, deadline 2038) names an Ethereum deposit address; ETH the forwarder pays
  there is credited by POA to 1Click's account and forwarded to `A`. One address served all three TWAP
  tranches. It replaced POA's `deposit_address`: POA's bridge RPC refuses anonymous calls (HTTP 403).
- **A ZEC delivery costs 72,000 zat** on every one so far, whatever the amount ([payout.md](payout.md)).

## Verified — the router's gates

Gates G1–G3 were run on mainnet on 2026-10-21, one full round.

**A counterparty exists only through a quote (G1).** `publish_intent` with `quote_hashes: []`
refuses a lone `token_diff` at publish time (`token deltas have positive balance`); it accepts only
bundles that balance on their own. The relay's `quote` needs a relay partner key; **1Click's** works
with ours. Its quote is signed — Ed25519 under its manager key, over a fixed field whitelist that
includes `recipient`, `refundTo` and the deposit account — and the router can verify it. With the
quote verified, a router-built transfer of exactly `amountIn` to the deposit account filled in 7 s,
above the floor, and the ZEC came back to `A` in the same atomic transaction.

**The bytes `intents.near` verifies (G2).** v0.4.5: NEP-413 digest signed once; versioned nonce
`5628f6c6 ‖ 0 ‖ salt ‖ expiry ns ‖ 15 bytes`; payload deadline must be **≤ the nonce expiry**; an
implicit account's own key is valid without registration. 12/12 cases through `simulate_intents`.

**POA credits ETH forwarded by a contract (G3).** An internal transfer from Disperse was credited in
1 min 16 s, in full. ETH minimum 1e11 wei. ZEC withdrawals below POA's listed 0.01 ZEC minimum pay
out; a delivery costs 0.00072 ZEC (the listed 0.00047 fee plus 0.00025 taken on chain).

**The live `v1.signer` request.** Proven by `utxo-withdraw` in production:
`sign({ request: { path, payload_v2: { Eddsa: hex }, domain_id: 1 } })`, 1 yocto, ≥ 15 TGas, answering
`{ scheme: "Ed25519", signature }`; ~21 TGas per sign, settled within about a minute.

**MPC derivation.** `v1.signer` is live on NEAR mainnet. `derived_public_key({path, predecessor,
domain_id: 1})` returns an Ed25519 key; derivation is keyed on `(predecessor, path)`, so the same path
from another account yields a disjoint `A`. `(router, path) → A` is deterministic across repeated
runs.

**Intents account model.** `intents.near` has no per-key scoping: every public key registered to an
account can sign intents on its behalf. Intent payloads carry a nonce, so signatures are single-use.

**Hydration price oracles are Chainlink-compatible.** Deployed oracles answer `latestRoundData()`,
`latestAnswer()`, `latestTimestamp()` and `decimals()` (= 8). `updatedAt` is the Hydration block time
of the last `setPrice`, which is what the dispatcher's liveness check reads.

**The oracle relay leg is in production.** `agents/relayer`'s `oracle` app relays `OracleEmitter`
VAAs into per-source `OracleReceiver` deployments on Hydration.

**ICE forward** (hydration-node master). `OnResolved::Forward { contract, data ≤ 512 bytes }`; a `Dca`
intent forwards on every trade, swaps only on full resolution; executed by the lazy executor in a later
block, `msg.sender == user`, value 0, gas 2,000,000; a revert or wrong ack rolls the push back; failed
forwards are not retried.

**Hydration Wormhole fee** is 0 (`messageFee()`, 2026-10-12).

**NEAR oracles are not usable as a local price.** `pyth-oracle.near` exists but is pull-based and its
feeds were months old (2026-10-12); `priceoracle.near` returns `null` for every asset. v2 therefore
prices on Hydration.
