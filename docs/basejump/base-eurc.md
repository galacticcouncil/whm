# Basejump Base → Hydration (EURC): switch-on

A user sends EURC on Base and receives EURC (asset 44) on Hydration in about 2 minutes, less a
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
| Relayer | `ntt` routes carry the EURC settlement leg; `basejump` routes have a Base entry with unfilled addresses (skipped) |
| Treasury | 972.155197 EURC, 139,701.92 USDT |

## Checklist

1. **Run the migration from the PR branch, before merge**: `pnpm migrate:basejump-base`
   (`PK` Base deployer, `PK_HYDRATION` Hydration deployer with an `EVMAccounts.ContractDeployer`
   slot). Steps 001-009 deploy both ends and hand them to the Base TC Safe and the emergency admin.
   Step 010 sends nothing: it checks the landing and records the motion's two landing calls. Commit
   `deployments/prod/basejump-base.json`. Safe to run early: until step 6 a payout reverts at the
   landing and the relayer retries.
2. **Verify the deployment**: the emitter's `landing()` and the receiver's `landing()` both equal
   the landing (invariant 1); emitter `nttManagerFor(Base EURC)` = `0xD1dc…d89a`,
   `quoteFee(Base EURC)` = 100,000 (0.1 EURC), owner = the Base TC Safe; receiver
   `authorizedEmitters(30)` = the emitter, owner = the emergency admin.
3. **Fill the relayer route**: in `agents/relayer/src/apps/basejump/routes.ts`, set the Base entry's
   `sourceEmitter` (001 `proxyAddress`) and `receiver` (005 `proxyAddress`). Merge, build, deploy the
   `basejump` app. Its startup log lists `base` among the relayed routes.
4. **Build and dry-run both proposals**:
   `npx tsx chopsticks/probes/_probeBasejumpBaseGoLive.ts --receiver <005 proxyAddress>`. It must end
   in a full pass. Take the referendum preimage and the `technicalCommittee.propose` call from its
   output; they change with the receiver address, the amounts and the gas price.
5. **Treasury referendum** (Treasurer track, draft below). Wait until it is enacted, then read the
   landing's EURC balance: 10,000 EURC.
6. **TC motion**: submit the `propose` call from step 4. It sets the route
   (`setDestAsset(Base EURC, asset 44)`) and then authorizes the Base receiver. This is the go-live
   switch.
7. **Verify on chain**: `destAssetFor(Base EURC)` = `0x…010000002C`,
   `authorizedBridges(<receiver>)` = true, the Ethereum route and receiver unchanged. Then a canary:
   send 10 EURC from Base and see 9.9 EURC arrive on Hydration.

Why fund before arming: armed over an empty pool, a payout is accepted but queued. Measured on the
fork: the delivery succeeds, the queue grows by one, and nobody is paid until the pool is funded and
someone calls `fulfillPending()`. No funds are lost, but the user waits.

Check outcomes by reading state, never by a proposal's result. `utility.batchAll` over
`dispatch_as_*` calls completes even when an inner call fails. Measured on the fork: with a failing
swap route the batch completed, the purchase and the transfer both failed, and the Treasury was
untouched.

## Treasury referendum (draft)

**Fund Basejump Base → Hydration EURC with a 10,000 EURC float**

- **What it does.** Basejump lets users move EURC from Base to Hydration and receive it in about
  2 minutes. A pool on Hydration pays each user at once; the slower NTT settlement of the same
  transfer refills the pool within about half an hour. The pool needs working capital to start.
- **Ask.** 10,000 EURC from the Treasury to the Basejump landing pool. Same size as the first EURC
  float (#319) and the USDC float of the Ethereum corridor (#404).
- **Source.** The Treasury holds about 972 EURC. It buys 9,050 EURC with at most 10,310 USDT, on
  chain: USDT is supplied to the Hydration money market as aUSDT, swapped through HOLLAR into aEURC
  (stableswap pools 111 and 10044), and withdrawn from the Hydration money market as EURC. On a fork
  at Hydration block 16,702,200 this cost 10,102.25 USDT (1.1163 USDT per EURC). About 22 EURC stays
  in the Treasury.
- **Safety.** The pool is owned by the Hydration Technical Committee (emergency admin), which can
  withdraw the float back to the Treasury at any time. It pays only transfers published by the
  authorized Base emitter, each the net of an amount its own settlement brings back to the pool.
- **Fee.** 0.1 EURC per transfer stays in the pool.
- **Calls.** `utility.batchAll` of two `dispatcher.dispatchAsTreasury` calls:
  `router.buy(USDT, EURC, 9,050 EURC, max 10,310 USDT, route)` and
  `currencies.transfer(<landing account>, EURC, 10,000 EURC)`. The landing account is
  `7KATdGb2mFNXsj7twGfcevvvcnRAMim1AoqohyCKrTN1tRAm` (the same account #319 funded). The preimage
  comes from the probe in step 4.

## Not covered here

- The superseded Base emitter `0x9c00…c4d2` is still armed and deployer-owned; a call to it settles
  into this pool with no receiver to pay the sender. It is disarmed separately with
  `setLandingDest(0)` (see `migrations/envs/prod/basejump-base.env`).
- Nothing calls `fulfillPending()` automatically yet (see [Relaying](spec.md#relaying)).
