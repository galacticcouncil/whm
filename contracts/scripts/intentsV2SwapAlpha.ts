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

/** The terms outlive the ICE intent by this much, for the order to cross to NEAR and fill. */
const TERMS_GRACE_S = 3600;

/**
 * Intents v2 alpha — one swap through a Hydration ICE intent, the way users place them: ICE sells
 * `--amountIn` of `--assetIn` for WETH and forwards it to the dispatcher's `execute`, which bridges it
 * as one order; the router then buys `--dest` for `--recipient` on NEAR.
 *
 *   1. Terms: owner and refundTo the signer, a fresh quoteId, maxFillMultiplier 2, the hard floor
 *      --floorBps under the dispatcher's live price, deadline the ICE deadline plus an hour.
 *   2. A for the terms, and its standing 1Click pass-through — the order's deposit address.
 *   3. The relay ceiling: the quoter, +20%.
 *   4. `Intent.submit_intent` — Swap(assetIn → WETH, at least --minWethOut, never partial), deadline
 *      --deadlineMinutes, Forward to the dispatcher with `abi.encode(deposit, ceiling, terms)` —
 *      through the dispatch precompile, as the signer. `--dryRun` simulates it and stops.
 *   5. Follow the trade in scan and A's balances until A is empty again.
 *
 * Env: RPC (Hydration EVM), ONECLICK_KEY; NEAR_RPC?, QUOTER_URL?, SCAN_API? (…/api/v2)
 * Args: --pk --assetIn --amountIn --minWethOut --recipient
 *       --kind? (withdraw | intents; default withdraw) --dest? (default nep141:zec.omft.near)
 *       --slippageBps? (300) --floorBps? (2000) --minDelivery? (1) --deadlineMinutes? (60)
 *       --dispatcher? --router? --dryRun? --wait? (minutes; 60)
 */
async function main(): Promise<void> {
  const pk = requiredArg("--pk") as Hex;
  const dispatcher = (optionalArg("--dispatcher") ?? DISPATCHER) as Hex;
  const router = optionalArg("--router") ?? ROUTER;
  const assetIn = Number(requiredArg("--assetIn"));
  const amountIn = BigInt(requiredArg("--amountIn"));
  const minWethOut = BigInt(requiredArg("--minWethOut"));
  const recipient = requiredArg("--recipient");
  const kind = (optionalArg("--kind") ?? "withdraw") as keyof typeof KIND;
  const dest = optionalArg("--dest") ?? "nep141:zec.omft.near";
  const deadlineMinutes = Number(optionalArg("--deadlineMinutes") ?? "60");
  if (!(kind in KIND)) throw new Error("--kind is withdraw or intents");

  const evm = wallet.getWallet(requiredEnv("RPC"), 222222, pk);
  const provider = new JsonRpcProvider({ url: optionalEnv("NEAR_RPC") ?? NEAR_RPC });
  const signer = evm.account.address;

  // 1. Terms.
  const market = (await evm.publicClient.readContract({
    address: dispatcher,
    abi: hydration.DISPATCHER_ABI,
    functionName: "outPerIn",
    args: [dest],
  })) as bigint;
  const iceDeadline = BigInt(Date.now() + deadlineMinutes * 60_000);
  const terms: hydration.Terms = {
    owner: signer,
    quoteId: `0x${randomBytes(32).toString("hex")}`,
    maxSlippageBps: Number(optionalArg("--slippageBps") ?? "300"),
    maxFillMultiplier: 2,
    minOutPerIn: (market * (BPS - BigInt(optionalArg("--floorBps") ?? "2000"))) / BPS,
    minDelivery: BigInt(optionalArg("--minDelivery") ?? "1"),
    deadline: iceDeadline / 1000n + BigInt(TERMS_GRACE_S),
    recipientKind: KIND[kind],
    refundTo: signer,
    destinationAsset: dest,
    recipient,
  };
  const { encoded, authPath } = await hydration.encodeTerms(evm.publicClient, dispatcher, terms);
  console.log(`1. terms     ${encoded}\n   authPath  ${authPath}\n   floor     ${terms.minOutPerIn} (now ${market})`);

  // 2. A, and where its orders deposit.
  const account = await near.deriveAccount(provider, router, authPath);
  const deposit = await near.passThrough(requiredEnv("ONECLICK_KEY"), account);
  console.log(`2. A         ${account}\n   deposit   ${deposit.address}  (1Click ${deposit.internal})`);

  // 3. The relay ceiling.
  const ceiling = await hydration.relayFeeCeiling(optionalEnv("QUOTER_URL") ?? QUOTER);
  console.log(`3. ceiling   ${formatEther(ceiling)} ETH`);

  // 4. The ICE intent.
  const intent: hydration.IntentInput = {
    data: { kind: "swap", assetIn, assetOut: hydration.WETH_ASSET_ID, amountIn, amountOut: minWethOut },
    deadline: iceDeadline,
    forward: { contract: dispatcher, data: hydration.forwardData(deposit.address as Hex, ceiling, encoded) },
  };
  if (process.argv.includes("--dryRun")) {
    await evm.publicClient.call({ account: evm.account, to: hydration.DISPATCH, data: hydration.encodeSubmitIntent(intent) });
    return console.log("4. dry run   submit_intent would succeed");
  }
  console.log(`4. submitted ${await hydration.submitIntent(evm, intent)}`);

  await follow(provider, account, dest, authPath, Number(optionalArg("--wait") ?? "60"));
}

/**
 * Follow a trade: scan's view of it, and A's balances, until A has held something and is empty again.
 *
 * @param provider A NEAR provider
 * @param account A
 * @param dest The destination asset
 * @param authPath The terms' `auth_path`
 * @param minutes How long to follow
 */
async function follow(provider: JsonRpcProvider, account: string, dest: string, authPath: Hex, minutes: number) {
  const scan = optionalEnv("SCAN_API");
  let last = "";
  let funded = false;
  for (const until = Date.now() + minutes * 60_000; Date.now() < until; await new Promise((r) => setTimeout(r, 15_000))) {
    const held = await near.balances(provider, account, [ETH, dest]);
    let trade = "";
    if (scan) {
      const r = await fetch(`${scan}/trades/${authPath}`);
      const t = r.ok ? ((await r.json()) as { trade: { status: string; order_count: number; swapped: number } }).trade : null;
      trade = t ? `trade ${t.status}, ${t.swapped}/${t.order_count} swapped, ` : `trade ${r.status}, `;
    }
    const line = `${trade}A: ${held[ETH]} wei ETH, ${held[dest]} out`;
    if (line !== last) console.log(`   +${new Date().toISOString().slice(11, 19)} ${(last = line)}`);
    const empty = held[ETH] === 0n && held[dest] === 0n;
    if (funded && empty) return console.log("\nDone: A is empty again — delivered, or refunded.");
    funded ||= !empty;
  }
  console.log(`\nFollowed for ${minutes} min.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
