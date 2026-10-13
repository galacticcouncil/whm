# VERIFICATION — Intents

What has actually been checked against a live system, and what is still an assumption. Treat anything
outside the **Verified** section as untested before writing code against it.

## Blocking — resolve before building further

**Exact bytes signed under `nep413` / `raw_ed25519`.** Must be pinned against the verifier's own
verification code — see [schema.md](schema.md) §4. A wrong guess is a silent total failure: signatures
are produced and rejected with nothing to indicate which field diverged.

**Router account id is registered and controlled by us.** `hydration.near` exists but is empty with no
contract, so confirm we hold its keys. `galacticcouncil.near` is currently unregistered. The id is
permanent (see [spec.md](spec.md) §3) and must be final before the first DCA schedule exists, because
every derived account depends on it.

**A solver fills an unmatched intent.** With the price fixed on-chain there is no `quote_hash` to bind
to, so the bot posts a limit order with `quote_hashes: []`. The empty array is accepted; whether
solvers take such an order from the book is untested, and the whole flow rests on it. Test this first
— a negative result invalidates the design.

That solvers *price* ETH→ZEC is settled: 1Click quotes it at production size. The relay's own `quote`
method is gated behind a Partner Portal `X-API-Key` (the 1Click distribution JWT is a different
credential and returns `result: null`), but it is no longer in the critical path.

## Unverified

**`SignRequest` field names on `v1.signer.sign`.** The *view* method takes `domain_id`, but the `sign`
request struct needs confirming — it was `key_version`.

**MPC signing latency in practice.** Together with the POA crediting delay it sizes `max_quote_age`
— the window a published price stays usable ([schema.md](schema.md) §3). Neither is measured.

**ZEC withdrawal pattern via `ft_withdraw`.** Confirm the POA withdrawal convention and the ZEC
withdrawal fee.

## Verified

**Hydration honours a requested consistency level.** Chain 73 runs a plain EVM watcher in `guardiand`
with no finalizer override, so level 200 skips the pending queue and is signed with zero
confirmations. Measured across 22 live order pairs: the `IntentEmitter` instruction (200) was signed
a median of 38s ahead of the WETH transceiver settlement (202) from the same transaction, range
30-46s. Both emitters now publish at 202 — see [schema.md](schema.md) — so this is recorded as the
reason rather than as an open question.

**A VAA's `timestamp` is the source block's, not the signing time.** Both legs of all 22 pairs carry
byte-identical body timestamps despite the ~38s signing gap. The watcher sets
`Timestamp: time.Unix(int64(blockTime), 0)` from the block holding the log, and the pending queue
republishes the same object unchanged at finality.

**NEAR / POA addressing.** `deposit_address` is stable and per-account — repeated calls return the
same value, distinct per account, and it works for implicit hex ids. The same H160 appears across EVM
chains with the token differing by chain: `eth:1 → eth.omft.near`, `eth:8453 → base.omft.near`,
`eth:42161 → arb.omft.near`. Native ETH on `eth:1` maps to `nep141:eth.omft.near` with `min_deposit`
of `1e11` wei.

**1Click behaviour.** Deposit addresses are non-deterministic — identical requests return different
addresses across all three modes, which is what rules out the 1Click path for DCA. `ANY_INPUT` rejects
`ORIGIN_CHAIN` with an explicit 400.

**ZEC destination addresses are transparent-only.** 1Click quotes ETH→ZEC to `t1` (P2PKH) and `t3`
(P2SH) addresses; `zs1` (sapling) and `u1` (unified) are rejected as `recipient is not valid`. Funds
therefore arrive at a public address — a privacy property worth stating to users of a Zcash route.
The rejected strings were self-constructed, so this is strong evidence rather than proof; a genuinely
valid shielded address would settle it.

**Hydration price oracles are Chainlink-compatible.** The deployed wstETH oracle answers
`latestRoundData()`, `latestAnswer()`, `latestTimestamp()` and `decimals()` (= 8), so
`IntentQuoteEmitter` can read a price and its `updatedAt` through `AggregatorV3`. Note `updatedAt` is
the Hydration block time when `OracleReceiver` called `setPrice`, not the source observation time —
the receiver's own `maxPriceAge` (300s) bounds the difference.

**The oracle relay leg is in production.** `agents/relayer`'s `oracle` app runs two routes, Solana and
Ethereum, into per-source `OracleReceiver` deployments. Adding a Pyth-backed feed is a `registerFeed`
on the existing Ethereum `OracleEmitter`, not a new integration.

**POA deposit addresses are not derivable by us.** The same H160 is returned for a given account
across `eth:1`, `eth:8453` and `eth:42161`; the address has no code on Ethereum and is not
`keccak256` of the account id in any encoding tried. It is POA's own derivation, so `0xN` must come
from their RPC — once per schedule, off-chain.

**Intents account model.** `intents.near` has no per-key scoping: *"Every public key registered to an
account can sign intents on its behalf."* Intent payloads carry a `nonce`, so signatures are
single-use. The solver relay endpoint and method shapes are confirmed from docs —
`POST https://solver-relay-v2.chaindefuser.com/rpc`.

**MPC derivation.** `v1.signer` is live on NEAR mainnet, `code_hash
EM7QrQMdd71hCHFL4RHkYQ2E4jmESpgu85mDZJu8jJJd`. The `derived_public_key({path, predecessor,
domain_id})` shape works with `domain_id: 1` returning Ed25519 — e.g.
`ed25519:2kbv31BMDHBK54RYMX1gKiSLCXMjWphF9sbxvH4o4D3S`. Derivation is keyed on `(predecessor, path)`,
so the same path from `attacker.near` yields a disjoint `A` and `0xN`. The full chain
`(router, path) → A → 0xN` is deterministic across repeated runs.

**Wormhole.** The `coreBridge` is configured for Hydration, present in the `xc-cfg` chain config.
Guardians sign chain-73 VAAs — 200 live ones sampled from Wormholescan, all signed, the newest hours
old.

## Implemented

**Hydration emitters can reach `publishMessage`.** `IntentQuoteEmitter.publishQuote` and
`IntentEmitter`'s per-order forwarding instruction both publish through the core bridge, covered by
`IntentQuoteEmitterTest` and `IntentEmitterTest`.
