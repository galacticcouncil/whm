import "dotenv/config";

import { isAddress, pad, keccak256, encodeAbiParameters, parseAbiItem, erc20Abi } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { OneClickService, QuoteRequest } from "@defuse-protocol/one-click-sdk-typescript";

import { args } from "@whm/common";
import { ifs, wallet } from "@whm/common/evm";

import tokenBridgeJson from "../out/ITokenBridge.sol/ITokenBridge.json";

const { requiredArg, requiredEnv, optionalEnv } = args;
const { getWallet } = wallet;

const ETHEREUM_WORMHOLE_ID = 2;

const ORIGIN_ASSET = "nep141:eth.omft.near";
const DESTINATION_ASSET = "nep141:wrap.near";
const SLIPPAGE_BPS = 100;

// The event the relayer's redeem emits once it forwards the unwrapped ETH to the depositAddress.
const INTENT_FORWARDED = parseAbiItem(
  "event IntentForwarded(bytes32 indexed intentId, address indexed asset, address indexed depositAddress, uint256 amount)",
);

/**
 * NIR (Near Intent Routing) leg-2 driver — WTT (wrapped-token-transfer) path, source side.
 *
 * No Basejump proxy and no pre-funded pool: the swapped WETH is bridged straight through the
 * Wormhole TokenBridge with a payload (payload-3), addressed to IntentReceiver on Ethereum. The
 * mrelayer bot picks up the VAA and relays it (redeem → unwrap WETH → native ETH → forward to the
 * OneClick depositAddress). This script does NOT relay — it bridges, waits for the bot's
 * `IntentForwarded` event, and notifies 1Click. For the no-bot manual relay, see nirViaWtt2.ts.
 *
 *   0. Quote the relay fee (maxRelayFee, +20% headroom) — gas-based, independent of the swap.
 *   1. 1Click quote for (--amount − maxRelayFee): the relay fee is skimmed on Ethereum, so the swap
 *      is sized to what actually lands at the depositAddress (--amount is the full WETH bridged).
 *   2. intentId + (intentId, depositAddress, maxRelayFee) payload that IntentReceiver decodes.
 *   3. approve(WETH) + TokenBridge.transferTokensWithPayload(WETH, --amount, ETHEREUM, receiver, 0, payload).
 *   4. Wait for IntentForwarded(depositAddress) on the IntentReceiver (emitted by the bot's redeem).
 *   5. submitDepositTx → notify 1Click.
 *
 * NOTE: needs a real network and the bot running. The bot quotes marginBps=0 at redeem time; if that
 * exceeds the payload's maxRelayFee it skips as unprofitable (then this script times out at step 4).
 *
 * Env: RPC, CHAIN_ID (Moonbeam); ETH_RPC, ETH_CHAIN_ID (Ethereum); QUOTER_URL?, MAX_FEE_MARGIN_BPS?
 * Args: --pk --tokenBridge(Moonbeam) --asset(WETH) --receiver(IntentReceiver, Ethereum)
 *       --amount(full WETH to bridge) --recipient(dest-chain)   (refund always goes to the signer)
 */
async function main(): Promise<void> {
  const rpcUrl = requiredEnv("RPC");
  const chainId = Number(requiredEnv("CHAIN_ID"));

  const privateKey = requiredArg("--pk") as `0x${string}`;
  const tokenBridge = requiredArg("--tokenBridge"); // Moonbeam Wormhole TokenBridge
  const asset = requiredArg("--asset"); // Moonbeam WETH
  const receiver = requiredArg("--receiver"); // IntentReceiver (Ethereum) — bridge recipient
  const amount = requiredArg("--amount"); // full WETH to bridge (smallest unit)
  const recipient = requiredArg("--recipient"); // final dest-chain recipient

  if (!isAddress(tokenBridge)) throw new Error("Invalid --tokenBridge (Moonbeam TokenBridge).");
  if (!isAddress(asset)) throw new Error("Invalid --asset (WETH).");
  if (!isAddress(receiver)) throw new Error("Invalid --receiver (IntentReceiver).");

  const { publicClient, walletClient } = getWallet(rpcUrl, chainId, privateKey);
  const refundTo = privateKeyToAccount(privateKey).address; // always the signer
  const deadline = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  // 0. Relay-fee ceiling first — gas-based, so it doesn't need the swap quote. maxRelayFee is the
  //    user-authorized ceiling carried in the payload (quoter + headroom, default +20%); the relayer
  //    charges its own marginBps=0 cost at redeem time, bounded by it. --amount is the full WETH
  //    bridged; the fee is skimmed on Ethereum, so the swap is quoted for amount − maxRelayFee.
  const quoterUrl = optionalEnv("QUOTER_URL") || "https://quoter-api.play.hydration.cloud";
  const marginBps = Number(optionalEnv("MAX_FEE_MARGIN_BPS") ?? "2000");
  const feeRes = await fetch(`${quoterUrl}/relay-fee?chain=ethereum&marginBps=${marginBps}`);
  if (!feeRes.ok) throw new Error(`quoter ${feeRes.status}: ${await feeRes.text()}`);
  const { feeRequested: maxRelayFeeStr } = (await feeRes.json()) as { feeRequested: string };
  const maxRelayFee = BigInt(maxRelayFeeStr);

  const sendAmount = BigInt(amount); // full WETH the user bridges
  if (sendAmount <= maxRelayFee) {
    throw new Error(`--amount ${sendAmount} must exceed maxRelayFee ${maxRelayFee}`);
  }
  // Conservative floor: the net that lands if the relayer charges the full ceiling. The relayer
  // usually charges less (feeRequested ≤ maxRelayFee), so the actual net lands ≥ swapAmount. With
  // FLEX_INPUT (below) that whole net is swapped — the unspent fee headroom is converted too, not
  // refunded. swapAmount is the base used to size the quote's minAmountIn/minAmountOut band.
  const swapAmount = sendAmount - maxRelayFee;
  console.log(
    `maxRelayFee=${maxRelayFee} (quoter ${quoterUrl}, +${marginBps}bps) → swap ${swapAmount} of ${sendAmount}`,
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

  // 2. Intent payload — (intentId, depositAddress, maxRelayFee), 96 bytes, what IntentReceiver decodes.
  const intentId = keccak256(
    encodeAbiParameters(
      [{ type: "string" }, { type: "address" }, { type: "uint256" }, { type: "string" }],
      [correlationId, depositAddress as `0x${string}`, BigInt(quote.amountIn), deadline],
    ),
  );
  const data = encodeAbiParameters(
    [{ type: "bytes32" }, { type: "address" }, { type: "uint256" }],
    [intentId, depositAddress as `0x${string}`, maxRelayFee],
  );

  // 3. Bridge the full --amount (TokenBridge truncates to 8 decimals; sub-1e10-wei dust stays at the
  //    signer). The relayer skims its fee on Ethereum, so the deposit nets ≥ the quoted swapAmount.
  const bridgeAmount = sendAmount;
  console.log(`  intentId=${intentId} bridgeAmount=${bridgeAmount}`);

  const approveTx = await walletClient.writeContract({
    address: asset as `0x${string}`,
    abi: erc20Abi,
    functionName: "approve",
    args: [tokenBridge as `0x${string}`, bridgeAmount],
  });
  await publicClient.waitForTransactionReceipt({ hash: approveTx });

  const { abi: tokenBridgeAbi } = tokenBridgeJson as ifs.ContractArtifact;
  const bridgeTx = await walletClient.writeContract({
    address: tokenBridge as `0x${string}`,
    abi: tokenBridgeAbi,
    functionName: "transferTokensWithPayload",
    args: [
      asset as `0x${string}`,
      bridgeAmount,
      ETHEREUM_WORMHOLE_ID,
      pad(receiver as `0x${string}`, { size: 32 }),
      0, // nonce — informational grouping only
      data,
    ],
  });
  await publicClient.waitForTransactionReceipt({ hash: bridgeTx });
  console.log(`\nBridge committed on Moonbeam: ${bridgeTx}`);

  // 4. The mrelayer bot relays the payload-3 VAA (redeem on Ethereum). This script does NOT redeem —
  //    it waits for the bot's IntentForwarded(depositAddress) on the IntentReceiver.
  const ethRpc = requiredEnv("ETH_RPC");
  const ethChainId = Number(requiredEnv("ETH_CHAIN_ID"));
  const { publicClient: ethPub } = getWallet(ethRpc, ethChainId, privateKey);

  const fromBlock = await ethPub.getBlockNumber();
  console.log(
    `\nWaiting for the bot to relay → IntentForwarded(${depositAddress}) on ${receiver}…`,
  );

  const POLL_MS = 10_000;
  const TIMEOUT_MS = 20 * 60 * 1000;
  const until = Date.now() + TIMEOUT_MS;
  let relayTx: `0x${string}` | undefined;
  while (!relayTx) {
    const logs = await ethPub.getLogs({
      address: receiver as `0x${string}`,
      event: INTENT_FORWARDED,
      args: { depositAddress: depositAddress as `0x${string}` },
      fromBlock,
    });
    if (logs.length > 0) {
      relayTx = logs[0].transactionHash as `0x${string}`;
      break;
    }
    if (Date.now() > until) {
      throw new Error(
        `Timed out waiting for IntentForwarded(${depositAddress}). Is the bot running, and is its ` +
          `marginBps=0 cost ≤ maxRelayFee (${maxRelayFee})?`,
      );
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  console.log(`Relayed: deposit landed → ${depositAddress} (IntentForwarded in ${relayTx}).`);

  // 5. Notify 1Click that the deposit landed (speeds up detection).
  const submit = await OneClickService.submitDepositTx({ depositAddress, txHash: relayTx });
  console.log("submitDepositTx:", JSON.stringify(submit, null, 2));
  console.log(`\nDone. Track 1Click status for ${depositAddress}.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
