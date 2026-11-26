import "dotenv/config";

import { randomBytes } from "node:crypto";

import { JsonRpcProvider } from "near-api-js";
import { erc20Abi, formatEther, type Hex } from "viem";

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

/** `--refundTest`: the ICE intent's and the terms' lifetimes — nothing fills, the bot then refunds. */
const REFUND_TEST_ICE_S = 10 * 60;
const REFUND_TEST_TERMS_S = 20 * 60;

/**
 * Intents v2 alpha — one swap, the way users place them: ICE sells `--amountIn` of `--assetIn` for
 * WETH and forwards it to the dispatcher's `execute`, which bridges it as one order; the router then
 * buys `--dest` and pays it out — ZEC and BTC to their own chains through the router's UTXO routes,
 * NEAR as native NEAR — or, `--kind intents`, to a NEAR intents account.
 *
 *   1. Terms: owner and refundTo the signer, a fresh quoteId, maxFillMultiplier 2, the hard floor
 *      --floorBps under the dispatcher's live price, deadline the ICE deadline plus an hour.
 *   2. The recipient, checked as the router will pay it: the route's withdraw contract validates a
 *      ZEC/BTC address, a NEAR recipient must exist. The relay ceiling (the quoter, +20%), and the
 *      least WETH (`minOrderWeth`) for which even a fill at the hard floor reaches the route's
 *      minimum — less could wait in A for good, so it is refused.
 *   3. A for the terms, and its standing 1Click pass-through — the order's deposit address.
 *   4. `Intent.submit_intent` — Swap(assetIn → WETH, at least --minWethOut, never partial), deadline
 *      --deadlineMinutes, Forward to the dispatcher with `abi.encode(deposit, ceiling, terms)` —
 *      through the dispatch precompile, as the signer. `--dryRun` simulates it and stops.
 *      `--direct` instead approves and `dispatch`es `--amount` of the signer's WETH, no ICE.
 *   5. Follow the trade — scan, A and A_utxo — until it is completed or refunded and its payout has
 *      landed on its chain.
 *
 * `--refundTest` puts the hard floor ten times above the market and the terms' deadline 20 minutes
 * out: nothing fills, and the bot refunds the ETH to the signer on Ethereum.
 *
 * Env: RPC (Hydration EVM), ONECLICK_KEY; NEAR_RPC?, QUOTER_URL?, SCAN_API? (…/api/v2)
 * Args: --pk --recipient; --assetIn --amountIn --minWethOut (ICE) | --direct --amount (WETH wei)
 *       --dest? (zec | btc | near | a ledger id; default zec) --kind? (withdraw | intents; default withdraw)
 *       --slippageBps? (300) --floorBps? (2000) --minDelivery? (1) --deadlineMinutes? (60)
 *       --refundTest? --dispatcher? --router? --dryRun? --wait? (minutes; 60)
 */
async function main(): Promise<void> {
  const pk = requiredArg("--pk") as Hex;
  const dispatcher = (optionalArg("--dispatcher") ?? DISPATCHER) as Hex;
  const router = optionalArg("--router") ?? ROUTER;
  const recipient = requiredArg("--recipient");
  const kind = (optionalArg("--kind") ?? "withdraw") as keyof typeof KIND;
  const dest = near.destination(optionalArg("--dest") ?? "zec");
  const slippageBps = Number(optionalArg("--slippageBps") ?? "300");
  const direct = process.argv.includes("--direct");
  const refundTest = process.argv.includes("--refundTest");
  const dryRun = process.argv.includes("--dryRun");
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
  const now = Date.now();
  const iceDeadline = BigInt(now + (refundTest ? REFUND_TEST_ICE_S * 1000 : Number(optionalArg("--deadlineMinutes") ?? "60") * 60_000));
  const termsDeadline = refundTest ? BigInt(Math.floor(now / 1000) + REFUND_TEST_TERMS_S) : iceDeadline / 1000n + BigInt(TERMS_GRACE_S);
  const terms: hydration.Terms = {
    owner: signer,
    quoteId: `0x${randomBytes(32).toString("hex")}`,
    maxSlippageBps: slippageBps,
    maxFillMultiplier: 2,
    minOutPerIn: refundTest ? market * 10n : (market * (BPS - BigInt(optionalArg("--floorBps") ?? "2000"))) / BPS,
    minDelivery: BigInt(optionalArg("--minDelivery") ?? "1"),
    deadline: termsDeadline,
    recipientKind: KIND[kind],
    refundTo: signer,
    destinationAsset: dest,
    recipient,
  };
  const { encoded, authPath } = await hydration.encodeTerms(evm.publicClient, dispatcher, terms);
  console.log(`1. terms     ${encoded}\n   authPath  ${authPath}`);
  console.log(`   dest      ${dest} → ${recipient}\n   floor     ${terms.minOutPerIn} (now ${market})${refundTest ? " — refund test: unreachable" : ""}`);

  // 2. The recipient as the router pays it, the relay ceiling, and the expected output.
  const route = await near.checkRecipient(provider, router, dest, KIND[kind], recipient);
  const ceiling = await hydration.relayFeeCeiling(optionalEnv("QUOTER_URL") ?? QUOTER);
  const weth = direct ? BigInt(requiredArg("--amount")) : BigInt(requiredArg("--minWethOut"));
  const expected = hydration.estimateOut(weth, ceiling, market, slippageBps);
  const routeMin = route && !refundTest ? BigInt(route.min_amount) : 0n;
  const least = hydration.minOrderWeth(await hydration.orderBase(evm.publicClient, dispatcher), ceiling, terms.minOutPerIn, routeMin);
  console.log(`2. payout    ${route ? `UTXO route via ${route.withdraw}, from ${route.min_amount}` : kind === "intents" ? "intents transfer" : "native NEAR"}`);
  console.log(`   ceiling   ${formatEther(ceiling)} ETH\n   expected  about ${expected} out`);
  console.log(`   least     ${formatEther(least)} WETH — ${routeMin > 0n ? "pays out at the hard floor" : "the dispatcher's least order"}`);
  if (weth < least) {
    throw new Error(`${formatEther(weth)} WETH is below ${formatEther(least)}: ${routeMin > 0n ? "a fill at the floor would wait in A for good" : "the dispatcher would refuse it"} — swap more WETH`);
  }

  // 3. A, and where its orders deposit.
  const account = await near.deriveAccount(provider, router, authPath);
  const deposit = await near.passThrough(requiredEnv("ONECLICK_KEY"), account);
  const utxo = route ? await near.utxoLeg(provider, route, dest, recipient) : undefined;
  console.log(`3. A         ${account}\n   deposit   ${deposit.address}  (1Click ${deposit.internal})`);
  if (utxo) console.log(`   A_utxo    ${utxo.account} on ${utxo.token}`);

  // 4. The order: an ICE intent, or a direct dispatch.
  if (direct) {
    const call = { address: dispatcher, abi: hydration.DISPATCHER_ABI, functionName: "dispatch", args: [weth, deposit.address as Hex, ceiling, terms] } as const;
    if (dryRun) return console.log("4. dry run   checks passed — a direct dispatch approves first, so it is not simulated");
    const approve = await evm.walletClient.writeContract({ address: hydration.WETH, abi: erc20Abi, functionName: "approve", args: [dispatcher, weth], chain: null, account: evm.account });
    await evm.publicClient.waitForTransactionReceipt({ hash: approve });
    const { request } = await evm.publicClient.simulateContract({ account: evm.account, ...call });
    const tx = await evm.walletClient.writeContract(request);
    await evm.publicClient.waitForTransactionReceipt({ hash: tx });
    console.log(`4. dispatch  ${tx}`);
  } else {
    const intent: hydration.IntentInput = {
      data: {
        kind: "swap",
        assetIn: Number(requiredArg("--assetIn")),
        assetOut: hydration.WETH_ASSET_ID,
        amountIn: BigInt(requiredArg("--amountIn")),
        amountOut: weth,
      },
      deadline: iceDeadline,
      forward: { contract: dispatcher, data: hydration.forwardData(deposit.address as Hex, ceiling, encoded) },
    };
    if (dryRun) {
      await evm.publicClient.call({ account: evm.account, to: hydration.DISPATCH, data: hydration.encodeSubmitIntent(intent) });
      return console.log("4. dry run   submit_intent would succeed");
    }
    console.log(`4. submitted ${await hydration.submitIntent(evm, intent)}`);
  }

  // 5. Follow it to its payout.
  await near.followTrade({
    provider,
    account,
    authPath,
    asset: dest,
    eth: ETH,
    utxo,
    scanApi: optionalEnv("SCAN_API"),
    minutes: Number(optionalArg("--wait") ?? "60"),
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
