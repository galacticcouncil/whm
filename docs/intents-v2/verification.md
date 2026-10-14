# VERIFICATION — Intents v2

What has been checked live for the v2 design ([spec.md](spec.md)), and what is still open. Facts
about the deployed rail it reuses: [../intents/verification.md](../intents/verification.md).

## Open — blocking the router

**Solvers fill an unmatched intent.** v2 posts a limit order with `quote_hashes: []`. The empty array is
accepted; whether solvers take it — including a catch-up-sized order — is untested. A negative result
invalidates the design.

**The exact bytes `intents.near` verifies.** NEP-413 digest, the versioned nonce layout (salt, i64
nanosecond expiry, 15-byte entropy), deadline semantics (including `== now`), swap plus withdrawal,
failed withdrawal. Pin against the deployed WASM — a wrong guess is a silent total failure.

**POA credits ETH forwarded by a contract.** `IntentReceiver` forwards from inside a contract call;
confirm POA's watcher credits internal transfers, and measure the minimum and the crediting delay.

**The live `v1.signer` request.** `payload_v2: { Eddsa: hex }` under `request` in the inspected source;
confirm against the deployed signer, with deposit, gas, latency and rejection behaviour.

## Open — before a canary

Price feeds live on Hydration (source undecided) · ICE `Forward` in the targeted runtime within 2M
gas · control of `intents-router.hydration-whm.near` and its DAO handoff · monitoring. Full list:
[plan.md §5](plan.md#5-gates).

## Verified

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
