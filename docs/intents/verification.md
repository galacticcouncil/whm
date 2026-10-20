# VERIFICATION — Intents

What has been checked against the live system for the deployed rail ([spec.md](spec.md)).

## Verified

**Hydration honours a requested consistency level.** Chain 73 runs a plain EVM watcher in `guardiand`
with no finalizer override, so level 200 skips the pending queue and is signed with zero
confirmations. Measured across 22 live order pairs: the `IntentEmitter` instruction (200) was signed
a median of 38s ahead of the WETH transceiver settlement (202) from the same transaction, range
30-46s. `IntentEmitter` now publishes at 202 — see [schema.md](schema.md) — so this is recorded as the
reason rather than as an open question.

**A VAA's `timestamp` is the source block's, not the signing time.** Both legs of all 22 pairs carry
byte-identical body timestamps despite the ~38s signing gap. The watcher sets
`Timestamp: time.Unix(int64(blockTime), 0)` from the block holding the log, and the pending queue
republishes the same object unchanged at finality.

**POA token mapping.** Native ETH on `eth:1` maps to `nep141:eth.omft.near` with `min_deposit` of
`1e11` wei. The same deposit H160 appears across EVM chains with the token differing by chain:
`eth:1 → eth.omft.near`, `eth:8453 → base.omft.near`, `eth:42161 → arb.omft.near`, so delivery must
be on chain 1.

**1Click behaviour.** Deposit addresses are non-deterministic — identical requests return different
addresses across all three modes. `ANY_INPUT` rejects `ORIGIN_CHAIN` with an explicit 400.

**ZEC destination addresses are transparent-only.** 1Click quotes ETH→ZEC to `t1` (P2PKH) and `t3`
(P2SH) addresses; `zs1` (sapling) and `u1` (unified) are rejected as `recipient is not valid`. Funds
therefore arrive at a public address — a privacy property worth stating to users of a Zcash route.
The rejected strings were self-constructed, so this is strong evidence rather than proof; a genuinely
valid shielded address would settle it.

**Wormhole.** The `coreBridge` is configured for Hydration, present in the `xc-cfg` chain config.
Guardians sign chain-73 VAAs — 200 live ones sampled from Wormholescan, all signed.

## Implemented

**`IntentEmitter` reaches `publishMessage`.** The per-order forwarding instruction publishes through
the core bridge, covered by `IntentEmitterTest`; pairing, release and fee rules by
`IntentReceiverTest`.
