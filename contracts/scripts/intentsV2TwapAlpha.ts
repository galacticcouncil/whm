import "dotenv/config";

import { randomBytes } from "node:crypto";

import { JsonRpcProvider } from "near-api-js";
import { formatEther, type Hex } from "viem";

import { args } from "@whm/common";
import { intents as hydration, wallet } from "@whm/common/evm";
import { intents as near } from "@whm/common/near";

const { requiredArg, optionalArg, requiredEnv, optionalEnv } = args;

/** The deployed intents v2 stack (deployments/prod/intents-v2.json). */
const DISPATCHER = "0x2c967d7e00a18c1c926fd77de733a27c3fdb3f2b";
const ROUTER = "intents-router.hydration-whm.near";
const QUOTER = "https://quoter-intent.play.hydration.cloud";
const NEAR_RPC = "https://free.rpc.fastnear.com";

const ETH = "nep141:eth.omft.near";
const BPS = 10_000n;
const KIND = { withdraw: 0, intents: 1 } as const;

/** Hydration's block time, for sizing the terms' deadline from the DCA's period. */
const BLOCK_S = 2;

/** The terms outlive the last tranche by this much, for it to cross to NEAR and fill. */
const TERMS_GRACE_S = 2 * 3600;

/**
 * Intents v2 alpha — a TWAP through a Hydration ICE DCA: every `--periodBlocks` ICE sells
 * `--perTrade` of `--assetIn` for WETH and forwards it to the dispatcher's `execute`, each trade one
 * order of the same terms — one account `A`, one deposit address, its output paid out from
 * `--minDelivery` (and the route's minimum) up and the rest at the deadline — ZEC and BTC to their own
 * chains through the router's UTXO routes, NEAR as native NEAR, or to an intents account.
 *
 *   1. Terms: as the swap's, but maxFillMultiplier --tranches (an order's price can clear tranches
 *      that missed theirs) and a deadline after the last tranche, plus two hours.
 *   2. The recipient, checked as the router will pay it; the relay ceiling (the quoter, +20%); the
 *      whole schedule's expected output against the route's minimum.
 *   3. A for the terms, and its standing 1Click pass-through — every tranche's deposit address.
 *   4. `Intent.submit_intent` — Dca(assetIn → WETH, --perTrade per trade for at least
 *      --minWethPerTrade, within --iceSlippageBps of ICE's oracle, budget --perTrade × --tranches,
 *      every --periodBlocks), no deadline (ICE refuses one on a DCA), Forward to the dispatcher.
 *      `--dryRun` simulates it and stops.
 *   5. Follow the trade — scan, A and A_utxo — until it is completed or refunded and its payouts
 *      have landed.
 *
 * Every tranche must bridge enough for the dispatcher: at least its minimum order plus the ceiling,
 * with the ceiling at most half — so size --minWethPerTrade well above twice the ceiling.
 *
 * Env: RPC (Hydration EVM), ONECLICK_KEY; NEAR_RPC?, QUOTER_URL?, SCAN_API? (…/api/v2)
 * Args: --pk --assetIn --perTrade --minWethPerTrade --tranches --recipient
 *       --periodBlocks? (150, ~5 min; ICE's minimum is 15) --iceSlippageBps? (300)
 *       --kind? (withdraw | intents; default withdraw) --dest? (zec | btc | near | a ledger id; default zec)
 *       --slippageBps? (300) --floorBps? (2000) --minDelivery? (1)
 *       --dispatcher? --router? --dryRun? --wait? (minutes; the schedule plus the grace)
 */
async function main(): Promise<void> {
  const pk = requiredArg("--pk") as Hex;
  const dispatcher = (optionalArg("--dispatcher") ?? DISPATCHER) as Hex;
  const router = optionalArg("--router") ?? ROUTER;
  const assetIn = Number(requiredArg("--assetIn"));
  const perTrade = BigInt(requiredArg("--perTrade"));
  const minWethPerTrade = BigInt(requiredArg("--minWethPerTrade"));
  const tranches = Number(requiredArg("--tranches"));
  const period = Number(optionalArg("--periodBlocks") ?? "150");
  const recipient = requiredArg("--recipient");
  const kind = (optionalArg("--kind") ?? "withdraw") as keyof typeof KIND;
  const dest = near.destination(optionalArg("--dest") ?? "zec");
  const slippageBps = Number(optionalArg("--slippageBps") ?? "300");
  if (!(kind in KIND)) throw new Error("--kind is withdraw or intents");
  if (tranches < 2) throw new Error("--tranches below 2 is a swap — use intentsV2SwapAlpha");

  const evm = wallet.getWallet(requiredEnv("RPC"), 222222, pk);
  const provider = new JsonRpcProvider({ url: optionalEnv("NEAR_RPC") ?? NEAR_RPC });
  const signer = evm.account.address;

  // 1. Terms, spanning the whole schedule.
  const market = (await evm.publicClient.readContract({
    address: dispatcher,
    abi: hydration.DISPATCHER_ABI,
    functionName: "outPerIn",
    args: [dest],
  })) as bigint;
  const scheduleS = tranches * period * BLOCK_S;
  const terms: hydration.Terms = {
    owner: signer,
    quoteId: `0x${randomBytes(32).toString("hex")}`,
    maxSlippageBps: slippageBps,
    maxFillMultiplier: Math.min(Math.max(tranches, 2), 100),
    minOutPerIn: (market * (BPS - BigInt(optionalArg("--floorBps") ?? "2000"))) / BPS,
    minDelivery: BigInt(optionalArg("--minDelivery") ?? "1"),
    deadline: BigInt(Math.floor(Date.now() / 1000) + scheduleS + TERMS_GRACE_S),
    recipientKind: KIND[kind],
    refundTo: signer,
    destinationAsset: dest,
    recipient,
  };
  const { encoded, authPath } = await hydration.encodeTerms(evm.publicClient, dispatcher, terms);
  console.log(`1. terms     ${encoded}\n   authPath  ${authPath}`);
  console.log(`   ${tranches} tranches every ${period} blocks (~${Math.round(scheduleS / 60)} min), floor ${terms.minOutPerIn}`);
  console.log(`   dest      ${dest} → ${recipient}`);

  // 2. The recipient as the router pays it, the relay ceiling, and the expected output.
  const route = await near.checkRecipient(provider, router, dest, KIND[kind], recipient);
  const ceiling = await hydration.relayFeeCeiling(optionalEnv("QUOTER_URL") ?? QUOTER);
  const perTranche = hydration.estimateOut(minWethPerTrade, ceiling, market, slippageBps);
  const expected = perTranche * BigInt(tranches);
  console.log(`2. payout    ${route ? `UTXO route via ${route.withdraw}, from ${route.min_amount}` : kind === "intents" ? "intents transfer" : "native NEAR"}`);
  console.log(`   ceiling   ${formatEther(ceiling)} ETH per tranche\n   expected  about ${perTranche} out per tranche, ${expected} in all`);
  if (route) {
    const min = BigInt(route.min_amount);
    if (expected < min) throw new Error(`about ${expected} out in all is below the route's ${min}: it would wait in A for good`);
    if (perTranche < min) console.log(`   note      a tranche buys less than the route's ${min}: payouts batch`);
  }

  // 3. A, and where every tranche deposits.
  const account = await near.deriveAccount(provider, router, authPath);
  const deposit = await near.passThrough(requiredEnv("ONECLICK_KEY"), account);
  const utxo = route ? await near.utxoLeg(provider, route, dest, recipient) : undefined;
  console.log(`3. A         ${account}\n   deposit   ${deposit.address}  (1Click ${deposit.internal})`);
  if (utxo) console.log(`   A_utxo    ${utxo.account} on ${utxo.token}`);

  // 4. The ICE DCA.
  const intent: hydration.IntentInput = {
    data: {
      kind: "dca",
      assetIn,
      assetOut: hydration.WETH_ASSET_ID,
      amountIn: perTrade,
      amountOut: minWethPerTrade,
      slippagePpm: Number(optionalArg("--iceSlippageBps") ?? "300") * 100,
      budget: perTrade * BigInt(tranches),
      period,
    },
    forward: { contract: dispatcher, data: hydration.forwardData(deposit.address as Hex, ceiling, encoded) },
  };
  if (process.argv.includes("--dryRun")) {
    await evm.publicClient.call({ account: evm.account, to: hydration.DISPATCH, data: hydration.encodeSubmitIntent(intent) });
    return console.log("4. dry run   submit_intent would succeed");
  }
  console.log(`4. submitted ${await hydration.submitIntent(evm, intent)}`);

  // 5. Follow the trade through its schedule to its payouts.
  await near.followTrade({
    provider,
    account,
    authPath,
    asset: dest,
    eth: ETH,
    utxo,
    scanApi: optionalEnv("SCAN_API"),
    minutes: Number(optionalArg("--wait") ?? String(Math.ceil((scheduleS + TERMS_GRACE_S) / 60))),
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
