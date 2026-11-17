import "dotenv/config";

import { isAddress, erc20Abi, parseEventLogs } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { OneClickService, QuoteRequest } from "@defuse-protocol/one-click-sdk-typescript";

import { args } from "@whm/common";
import { ifs, wallet } from "@whm/common/evm";

import intentEmitterJson from "../out/IntentEmitter.sol/IntentEmitter.json";

const { requiredArg, requiredEnv, optionalEnv } = args;
const { getWallet } = wallet;

const ORIGIN_ASSET = "nep141:eth.omft.near";
const DESTINATION_ASSET = "nep141:wrap.near";
const SLIPPAGE_BPS = 100;

/**
 * NIR (Near Intent Routing) leg-2 driver — NTT path, source side.
 *
 * No TokenBridge payload and no intentId: `IntentEmitter.placeOrder` sells the asset for WETH,
 * settles it over NTT to IntentReceiver on Ethereum, and publishes `depositAddress` beside it as
 * its own Wormhole message. This script only places the order — the relayer's `intent` app pairs
 * the two VAAs and calls processOrder (deliver → pay caller → forward to the depositAddress), and
 * the intent agent's relayer app (agents/intent) watches the resulting `OrderProcessed` and
 * notifies 1Click.
 *
 *   0. Quote the relay fee (maxRelayFee, +20% headroom) — gas-based, independent of the swap.
 *   1. 1Click quote for (--ethOut − maxRelayFee): the relay fee is skimmed on Ethereum, so the swap
 *      is sized to what actually lands at the depositAddress (--ethOut is the full WETH settled).
 *   2. approve(assetIn) + placeOrder(assetIn, amountIn, minEthOut, depositAddress, maxRelayFee).
 *
 * Returns once the order is committed; the relayer forwards and the intent agent notifies 1Click
 * out-of-band.
 *
 * --ethOut is an estimate, and has to be: depositAddress is an argument to placeOrder, so the quote
 * must exist before the swap that decides how much WETH there is. FLEX_INPUT absorbs the gap.
 *
 * NOTE: needs a real network and the relayer running. It quotes marginBps=0 at processOrder time;
 * if that exceeds the order's maxRelayFee it skips as unprofitable and the deposit never lands.
 *
 * Env: RPC, CHAIN_ID (Hydration); QUOTER_URL?, MAX_FEE_MARGIN_BPS?
 * Args: --pk --address(IntentEmitter) --assetIn(Hydration asset id) --amountIn
 *       --ethOut(expected WETH from the swap) --recipient(dest-chain)
 *       (refund always goes to the signer)
 */

// Hydration asset id → ERC20-precompile address: 0x0100000000 | assetId (HydrationConsts.toErc20).
function assetErc20(assetId: number): `0x${string}` {
  const v = (1n << 32n) + BigInt(assetId);
  return ("0x" + v.toString(16).padStart(40, "0")) as `0x${string}`;
}

async function main(): Promise<void> {
  const rpcUrl = requiredEnv("RPC");
  const chainId = Number(requiredEnv("CHAIN_ID"));

  const privateKey = requiredArg("--pk") as `0x${string}`;
  const address = requiredArg("--address"); // IntentEmitter (Hydration)
  const assetIn = Number(requiredArg("--assetIn")); // Hydration asset id sold for WETH
  const amountIn = BigInt(requiredArg("--amountIn")); // assetIn pulled from the caller
  const ethOut = BigInt(requiredArg("--ethOut")); // expected WETH out of the swap
  const recipient = requiredArg("--recipient"); // final dest-chain recipient

  if (!isAddress(address)) throw new Error("Invalid --address (IntentEmitter).");
  if (!Number.isInteger(assetIn) || assetIn < 0) throw new Error("Invalid --assetIn (asset id).");

  const { publicClient, walletClient } = getWallet(rpcUrl, chainId, privateKey);
  const refundTo = privateKeyToAccount(privateKey).address; // always the signer
  const deadline = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  // 0. Relay-fee ceiling first — gas-based, so it doesn't need the swap quote. maxRelayFee is the
  //    user-authorized ceiling carried in the instruction (quoter + headroom, default +20%); the
  //    relayer charges its own marginBps=0 cost at processOrder time, bounded by it. --ethOut is the
  //    full WETH settled; the fee is skimmed on Ethereum, so the swap is quoted for ethOut − fee.
  const quoterUrl = optionalEnv("QUOTER_URL") || "https://quoter-intent.play.hydration.cloud";
  const marginBps = Number(optionalEnv("MAX_FEE_MARGIN_BPS") ?? "2000");
  // No gasLimit: the quoter models the envelope itself, and overriding it here would replace that
  // model with a guess. See docs/intents/relay-fee.md.
  const feeRes = await fetch(
    `${quoterUrl}/relay-fee?chain=ethereum&feeAsset=native&marginBps=${marginBps}`,
  );
  if (!feeRes.ok) throw new Error(`quoter ${feeRes.status}: ${await feeRes.text()}`);
  const { feeRequested: maxRelayFeeStr } = (await feeRes.json()) as { feeRequested: string };
  const maxRelayFee = BigInt(maxRelayFeeStr);

  if (ethOut <= maxRelayFee) {
    throw new Error(`--ethOut ${ethOut} must exceed maxRelayFee ${maxRelayFee}`);
  }
  // Conservative floor: the net that lands if the relayer charges the full ceiling. The relayer
  // usually charges less (feeRequested ≤ maxRelayFee), so the actual net lands ≥ swapAmount. With
  // FLEX_INPUT (below) that whole net is swapped — the unspent fee headroom is converted too, not
  // refunded. swapAmount is the base used to size the quote's minAmountIn/minAmountOut band.
  const swapAmount = ethOut - maxRelayFee;
  console.log(
    `maxRelayFee=${maxRelayFee} (quoter ${quoterUrl}, +${marginBps}bps) → swap ${swapAmount} of ${ethOut}`,
  );

  // 1. Quote — FLEX_INPUT so the swap consumes whatever actually lands (≥ minAmountIn), not a fixed
  //    amountIn. swapAmount sizes the band; the surplus from a below-ceiling relay fee is swapped,
  //    not refunded as origin-chain ETH (which is what EXACT_INPUT would do).
  const quoteRequest: QuoteRequest = {
    dry: false,
    swapType: QuoteRequest.swapType.FLEX_INPUT,
    slippageTolerance: SLIPPAGE_BPS,
    originAsset: ORIGIN_ASSET,
    depositType: QuoteRequest.depositType.ORIGIN_CHAIN,
    destinationAsset: DESTINATION_ASSET,
    amount: swapAmount.toString(),
    refundTo,
    refundType: QuoteRequest.refundType.ORIGIN_CHAIN,
    recipient,
    recipientType: QuoteRequest.recipientType.DESTINATION_CHAIN,
    deadline,
  };

  console.log("Requesting 1Click quote…");
  const { quote, correlationId } = await OneClickService.getQuote(quoteRequest);
  const depositAddress = quote.depositAddress;
  if (!depositAddress || !isAddress(depositAddress)) {
    throw new Error(`1Click did not return a usable Ethereum depositAddress: ${depositAddress}`);
  }
  console.log(
    `  depositAddress=${depositAddress} amountIn=${quote.amountIn} amountOut=${quote.amountOut}`,
  );

  // 2. Place the order. Not payable: the rail's delivery price and the message fee come out of the
  //    swap output, which works because Hydration's native currency IS WETH.
  const { abi } = intentEmitterJson as ifs.ContractArtifact;
  const assetToken = assetErc20(assetIn);
  console.log(`  correlationId=${correlationId} assetIn=${assetIn} (${assetToken})`);

  const approveTx = await walletClient.writeContract({
    address: assetToken,
    abi: erc20Abi,
    functionName: "approve",
    args: [address as `0x${string}`, amountIn],
  });
  await publicClient.waitForTransactionReceipt({ hash: approveTx });

  const orderTx = await walletClient.writeContract({
    address: address as `0x${string}`,
    abi,
    functionName: "placeOrder",
    // minEthOut is 0: the quote's minAmountOut is what bounds the user's outcome, and a floor here
    // would revert the swap rather than let 1Click refund.
    args: [assetIn, amountIn, 0n, depositAddress as `0x${string}`, maxRelayFee],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: orderTx });
  console.log(`\nOrder committed on Hydration: ${orderTx}`);

  // The NTT manager's sequence, not a Wormhole one — it is what the receiver matches the settlement
  // and its forwarding instruction on.
  const placed = parseEventLogs({ abi, eventName: "OrderPlaced", logs: receipt.logs })[0];
  const { transferSequence, ethOut: actual } = (placed?.args ?? {}) as {
    transferSequence?: bigint;
    ethOut?: bigint;
  };
  console.log(`  transferSequence=${transferSequence} ethOut=${actual} (estimated ${ethOut})`);

  // 3. Done. The relayer pairs the settlement with its instruction and forwards to depositAddress;
  //    the intent agent watches OrderProcessed and notifies 1Click.
  console.log(
    `\nDone. Relayer forwards → intent agent notifies 1Click. Track status for ${depositAddress}.`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
