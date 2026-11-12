# VERIFICATION — Intents v2

What has been checked live for the v2 design ([spec.md](spec.md)), and what is still open.

## Open — blocking the router

**Refunds through 1Click.** Neither 1Click refunding `A` (a swap that does not fill) nor the router's
post-deadline refund has been run.

## Open — before a canary

DIA price routes set on Hydration · ICE `Forward` in the targeted runtime, `execute` within 2M
gas · the WETH NTT managers carrying the transfer payload · control of `intents-router.hydration-whm.near` and its DAO handoff · monitoring. Full list:
[plan.md §5](plan.md#5-gates).

## Verified

Gates G1–G3 were run on mainnet on 2026-10-21 — one full round, every transaction listed:
[poc.md](poc.md).

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
from another account yields a disjoint `A` and `0xN`. The chain `(router, path) → A → 0xN` is
deterministic across repeated runs.

**POA addressing.** `deposit_address` is stable and per-account — repeated calls return the same
value, distinct per account, and it works for implicit hex ids. It is POA's own derivation (no code
at the address, not a hash of the account id), so `0xN` must come from their RPC, once per action.

**Intents account model.** `intents.near` has no per-key scoping: every public key registered to an
account can sign intents on its behalf. Intent payloads carry a nonce, so signatures are single-use.

**Hydration price oracles are Chainlink-compatible.** Deployed oracles answer `latestRoundData()`,
`latestAnswer()`, `latestTimestamp()` and `decimals()` (= 8). `updatedAt` is the Hydration block time
of the last `setPrice`, which is what the dispatcher's liveness check reads.

**The oracle relay leg is in production.** `agents/relayer`'s `oracle` app relays `OracleEmitter`
VAAs into per-source `OracleReceiver` deployments on Hydration.

**ICE forward** (hydration-node master). `OnResolved::Forward { contract, data ≤ 512 bytes }`; DCA
forwards on every trade, swaps only on full resolution; executed by the lazy executor in a later
block, `msg.sender == user`, value 0, gas 2,000,000; a revert or wrong ack rolls the push back; failed
forwards are not retried.

**Hydration Wormhole fee** is 0 (`messageFee()`, 2026-10-12).

**NEAR oracles are not usable as a local price.** `pyth-oracle.near` exists but is pull-based and its
feeds were months old (2026-10-12); `priceoracle.near` returns `null` for every asset. v2 therefore
prices on Hydration.
