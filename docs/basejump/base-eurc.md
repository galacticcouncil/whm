# Basejump Base → Hydration (EURC): switch-on

A user sends EURC on Base and receives EURC (asset 44) on Hydration in about 2.5-3.5 minutes, less a
0.1 EURC fee. The pool on Hydration pays at once; the transfer's own NTT settlement refills it
later. Contracts and tooling are ready; the corridor is not live.

## State before switch-on

Read on chain at Hydration block 16,702,133 and Base block 54,037,872 (2026-11-07). Every contract
here is upgradeable, so re-read before acting.

| What | Value |
| --- | --- |
| Landing `0x70e9…f976`, Base EURC route | `destAssetFor(Base EURC)` = 0 (unmapped by referendum #404) |
| Landing balances | 0 EURC, 10,007.4 USDC (the Ethereum corridor's float) |
| Landing owner | emergency admin `0xAA7e…AA7E1` (Root or a TC majority) |
| Emergency admin EVM gas | 0.016 WETH, enough for the motion's two calls |
| `basejump-base` migration | never run: no Base emitter, no Base receiver |
| Hydration EURC NttManager `0x8dd1…bc4C` | `token()` = asset 44, BURNING, peer = the Base EURC manager |
| Base EURC NttManager `0xD1dc…d89a` | `token()` = Base EURC, LOCKING, peer = the Hydration manager |
| Superseded Base senders `0x9c00…c4d2`, `0xf5b9…529b` | both still armed: `landingDest()` = the landing (Base block 54,047,004) |
| Relayer | `ntt` routes carry the EURC settlement leg; `basejump` routes have a Base entry with unfilled addresses (skipped) |
| Treasury | 972.155197 EURC, 139,701.92 USDT |
| Hydration money market | 71,545.28 EURC withdrawable (EURC held by aEURC `0xCA30…C72e`, block 16,703,293) |

## Checklist

The Base emitter is deployed **disarmed** (`landing` unset): until the Base TC Safe arms it in the
last step, `bridgeViaWormhole` reverts `LandingNotSet` before any token is pulled. So there is never
a moment when users can send EURC on Base while the Hydration end cannot pay them.

1. **Run the migration from the PR branch, before merge**: `pnpm migrate:basejump-base`
   (`PK` Base deployer, `PK_HYDRATION` Hydration deployer with an `EVMAccounts.ContractDeployer`
   slot). Steps 001-009 deploy both ends, leave the emitter disarmed (002 checks it) and hand them
   to the Base TC Safe and the emergency admin. Steps 010 and 011 send nothing: 010 checks the
   landing and the EURC settlement leg and records the motion's two landing calls; 011 checks the
   emitter and records the Safe's arming call. Commit `deployments/prod/basejump-base.json`. Safe to
   run at any time: nobody can send through the disarmed emitter.
2. **Verify the deployment**: emitter `landing()` = 0 (disarmed), `nttManagerFor(Base EURC)` =
   `0xD1dc…d89a`, `quoteFee(Base EURC)` = 100,000 (0.1 EURC), `CONSISTENCY_LEVEL()` = 201 (safe),
   owner = the Base TC Safe; receiver
   `landing()` = the landing, `authorizedEmitters(30)` = the emitter, owner = the emergency admin.
3. **Fill the relayer route**: in `agents/relayer/src/apps/basejump/routes.ts`, set the Base entry's
   `sourceEmitter` (001 `proxyAddress`) and `receiver` (005 `proxyAddress`). Merge, build, deploy the
   `basejump` app. Its startup log lists `base` among the relayed routes.
4. **Build and dry-run both proposals**:
   `npx tsx chopsticks/probes/_probeBasejumpBaseGoLive.ts --receiver <005 proxyAddress> --float <EURC>`.
   It must end in a full pass. Take the referendum preimage and the `technicalCommittee.propose`
   call from its output; they change with the receiver address, the float, the swap price and the
   gas price.
5. **Treasury referendum** (Treasurer track, draft below). Wait until it is enacted, then read the
   landing's EURC balance: the float.
6. **TC motion**: submit the `propose` call from step 4. It sets the route
   (`setDestAsset(Base EURC, asset 44)`) and then authorizes the Base receiver. Read both back: a
   `batchAll` leg that fails is only an event, so a half-applied motion is possible. It is
   recoverable (nobody can send yet), not lossy.
7. **Disarm the superseded Base senders**: `0x9c00…c4d2` (deployer key) and `0xf5b9…529b` (Base TC
   Safe), each `setLandingDest(bytes32(0))`; both must read `landingDest()` = 0. A send through either
   settles into this pool with no receiver to pay it.
8. **Arm the emitter (go-live)**: the Base TC Safe sends step 011's `armCalldata` to the emitter
   (`setLanding(pad(landing))`, value 0). Only now can users send.
9. **Verify on chain**: `destAssetFor(Base EURC)` = `0x…010000002C`,
   `authorizedBridges(<receiver>)` = true, the Ethereum route and receiver unchanged, the emitter's
   `landing()` = the landing (invariant 1). Then a canary: send 10 EURC from Base and see 9.9 EURC
   arrive on Hydration.

To pause the corridor later, the Safe sends `setLanding(bytes32(0))`; sends revert again with
funds kept.

Why fund before authorizing: authorized over an empty pool, a payout is accepted but queued.
Measured on the fork: the delivery succeeds, the queue grows by one, and nobody is paid until the
pool is funded and someone calls `fulfillPending()`. With the emitter disarmed until step 8 this
cannot happen to a user, but it is why the checklist funds first.

Check outcomes by reading state, never by a proposal's result. `utility.batchAll` over
`dispatch_as_*` calls completes even when an inner call fails. Measured on the fork: with a failing
swap route the batch completed, the purchase and the transfer both failed, and the Treasury was
untouched.

## Fast-path consistency

The Base emitter publishes its fast-path message at Wormhole consistency level **201 (safe)**, set
by `FAST_PATH_CONSISTENCY_BASE` in `basejump-base.env` and baked into the emitter implementation by
step 001. The Ethereum emitter stays at **200 (instant)**.

- **Why not 200.** At 200 the guardians sign from Base's unsafe head. A sequencer reorg or a batch
  derivation divergence could orphan the source transaction after its VAA was signed: the pool would
  pay a VAA whose NTT settlement (which waits for finality) never arrives. At 201 the guardians sign
  only once the block is at or below Base's `safe` head, which means its batch is posted to L1; what
  remains is an L1 reorg deep enough to drop that batch before L1 finality.
- **Why not finalized.** Finalized takes about as long as the NTT settlement itself (15-21 min of
  head lag measured), so the fast path would add nothing.
- **Latency.** Base's `safe` head trailed `latest` by 14-91 s (15 samples, 2026-11-08, a sawtooth
  from batch posting), against 908-1289 s for `finalized`. Expected time to payout is therefore
  about 2.5-3.5 minutes instead of about 2: the instant path's time plus that lag. Guardian signing
  time at 201 has not been measured; it adds to the head lag.
- **Checks.** Step 001 reads `CONSISTENCY_LEVEL()` back from the new implementation; step 011 refuses
  to record the arming call unless the emitter reports 201. The level is the implementation's, so
  any later upgrade of the Base emitter must be built with 201 again.

## Treasury referendum (draft)

The float is the one parameter. The EURC needed is the float minus the Treasury's EURC, rounded up
to 50 EURC; the Treasury sells exactly 1.14 USDT per EURC needed, with the EURC needed as the minimum
out, and any EURC above it stays in the Treasury. A sell, not a buy: on the fork a 19,050 EURC
`router.buy` with that ceiling failed (`Stableswap.InsufficientBalance`) while the same purchase as a
sell succeeded. The figures below are fork readings (`--float`, Hydration block 16,702,200) and must
be re-measured before submitting.

| Float | EURC needed (minimum out) | USDT sold | EURC received (fork) | Money market EURC withdrawable after (fork) |
| --- | --- | --- | --- | --- |
| 10,000 EURC | 9,050 | 10,317 | 9,242.378485 (1.1163 USDT per EURC) | 62,302.90 (from 71,545.28) |
| 20,000 EURC | 19,050 | 21,717 | 19,436.467082 (1.1173 USDT per EURC) | 52,108.82 (from 71,545.28) |

**Fund Basejump Base → Hydration EURC with a 10,000 EURC float** (or 20,000)

- **What it does.** Basejump lets users move EURC from Base to Hydration and receive it in about
  3 minutes. A pool on Hydration pays each user at once; the slower NTT settlement of the same
  transfer refills the pool within about half an hour. The pool needs working capital to start.
- **Ask.** The float, from the Treasury to the Basejump landing pool. 10,000 EURC is the size of the
  first EURC float (#319) and of the Ethereum corridor's USDC float (#404).
- **Source.** The Treasury holds about 972 EURC and buys the rest with USDT, on chain: USDT is
  supplied to the Hydration money market as aUSDT, swapped through HOLLAR into aEURC (stableswap
  pools 111 and 10044), and withdrawn from the Hydration money market as EURC. Cost: the table above.
- **Safety.** The pool is owned by the Hydration Technical Committee (emergency admin), which can
  withdraw the float back to the Treasury at any time. It pays only messages from the authorized
  Base emitter, each the net of a transfer whose own settlement brings the gross back to the pool.
  The pool is shared with the Ethereum USDC corridor and does not tie a sender to an asset, so a
  Base-emitter message naming USDC would be paid from the USDC float. Only an upgrade or a
  `setNttManager` of the Base emitter by its owner, the Base TC Safe, could produce one; that Safe
  already owns the Ethereum emitter and so already holds this power over the pool.
- **Fee.** 0.1 EURC per transfer stays in the pool.
- **Calls.** `utility.batchAll` of two `dispatcher.dispatchAsTreasury` calls:
  `router.sell(USDT, EURC, <USDT sold>, <EURC needed>, route)` and
  `currencies.transfer(<landing account>, EURC, <float>)`. The landing account is
  `7KATdGb2mFNXsj7twGfcevvvcnRAMim1AoqohyCKrTN1tRAm` (the same account #319 funded). The preimage
  comes from the probe in step 4.

## Not covered here

- Nothing calls `fulfillPending()` automatically yet (see [Relaying](spec.md#relaying)).
