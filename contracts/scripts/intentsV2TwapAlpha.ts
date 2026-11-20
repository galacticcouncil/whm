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
 * order of the same terms — one account `A`, one deposit address, its output delivered from
 * `--minDelivery` up and the rest at the deadline.
 *
 *   1. Terms: as the swap's, but maxFillMultiplier --tranches (an order's price can clear tranches
 *      that missed theirs) and a deadline after the last tranche, plus two hours.
 *   2. A for the terms, and its standing 1Click pass-through — every tranche's deposit address.
 *   3. The relay ceiling: the quoter, +20%.
 *   4. `Intent.submit_intent` — Dca(assetIn → WETH, --perTrade per trade for at least
 *      --minWethPerTrade, within --iceSlippageBps of ICE's oracle, budget --perTrade × --tranches,
 *      every --periodBlocks), no deadline (ICE refuses one on a DCA), Forward to the dispatcher.
 *      `--dryRun` simulates it and stops.
 *   5. Follow the plan in scan until its status leaves `active`.
 *
 * Every tranche must bridge enough for the dispatcher: at least its minimum order plus the ceiling,
 * with the ceiling at most half — so size --minWethPerTrade well above twice the ceiling.
 *
 * Env: RPC (Hydration EVM), ONECLICK_KEY; NEAR_RPC?, QUOTER_URL?, SCAN_API? (…/api/v2/orders)
 * Args: --pk --assetIn --perTrade --minWethPerTrade --tranches --recipient
 *       --periodBlocks? (150, ~5 min; ICE's minimum is 15) --iceSlippageBps? (300)
 *       --kind? (withdraw | intents; default withdraw) --dest? (default nep141:zec.omft.near)
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
  const dest = optionalArg("--dest") ?? "nep141:zec.omft.near";
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
    maxSlippageBps: Number(optionalArg("--slippageBps") ?? "300"),
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

  // 2. A, and where every tranche deposits.
  const account = await near.deriveAccount(provider, router, authPath);
  const deposit = await near.passThrough(requiredEnv("ONECLICK_KEY"), account);
  console.log(`2. A         ${account}\n   deposit   ${deposit.address}  (1Click ${deposit.internal})`);

  // 3. The relay ceiling, one for every tranche.
  const ceiling = await hydration.relayFeeCeiling(optionalEnv("QUOTER_URL") ?? QUOTER);
  console.log(`3. ceiling   ${formatEther(ceiling)} ETH per tranche`);

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

  // 5. Follow the plan through its schedule.
  const minutes = Number(optionalArg("--wait") ?? String(Math.ceil((scheduleS + TERMS_GRACE_S) / 60)));
  const scan = optionalEnv("SCAN_API");
  let last = "";
  for (const until = Date.now() + minutes * 60_000; Date.now() < until; await new Promise((r) => setTimeout(r, 30_000))) {
    const held = await near.balances(provider, account, [ETH, dest]);
    let plan = "";
    let status = "";
    if (scan) {
      const r = await fetch(`${scan}/plans/${authPath}`);
      const p = r.ok ? ((await r.json()) as { plan: { status: string; tranches: number; swapped: number } }).plan : null;
      status = p?.status ?? "";
      plan = p ? `plan ${p.status}, ${p.swapped}/${p.tranches} swapped, ` : `plan ${r.status}, `;
    }
    const line = `${plan}A: ${held[ETH]} wei ETH, ${held[dest]} out`;
    if (line !== last) console.log(`   +${new Date().toISOString().slice(11, 19)} ${(last = line)}`);
    if (status && status !== "active") return console.log(`\nDone: plan ${status}.`);
  }
  console.log(`\nFollowed for ${minutes} min.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
