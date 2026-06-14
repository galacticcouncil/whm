import "dotenv/config";

import { isAddress, pad, keccak256, encodeAbiParameters, parseEventLogs, erc20Abi } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { OneClickService, QuoteRequest } from "@defuse-protocol/one-click-sdk-typescript";

import { args } from "@whm/common";
import { ifs, wallet } from "@whm/common/evm";
import { fetchVaaHex, LOG_MESSAGE_PUBLISHED } from "@whm/common/wormhole";

import tokenBridgeJson from "../out/ITokenBridge.sol/ITokenBridge.json";
import intentReceiverJson from "../out/IntentReceiver.sol/IntentReceiver.json";

const { requiredArg, requiredEnv, optionalEnv } = args;
const { getWallet } = wallet;

const ETHEREUM_WORMHOLE_ID = 2;
const MOONBEAM_WORMHOLE_ID = 16;

const ORIGIN_ASSET = "nep141:eth.omft.near";
const DESTINATION_ASSET = "nep141:wrap.near";
const SLIPPAGE_BPS = 100;

/**
 * End-to-end NIR (Near Intent Routing) leg-2 driver — WTT (wrapped-token-transfer) path.
 *
 * No Basejump proxy and no pre-funded pool: the swapped WETH is bridged straight through the
 * Wormhole TokenBridge with a payload (payload-3), and IntentReceiver on Ethereum redeems it,
 * unwraps WETH → native ETH, and forwards to the OneClick depositAddress. Viable for the
 * Moonbeam→Ethereum direction because Moonbeam finalizes in ~seconds. For the Basejump-proxy
 * fast-path variant, see nirViaBjp.ts.
 *
 *   1. 1Click quote (ORIGIN_ASSET → DESTINATION_ASSET) → quote-specific Ethereum depositAddress.
 *   2. intentId + (intentId, depositAddress) payload that IntentReceiver decodes.
 *   3. approve(WETH) + TokenBridge.transferTokensWithPayload(WETH, amountIn, ETHEREUM, receiver, 0, payload).
 *   4. Fetch the payload-3 VAA, IntentReceiver.redeem on Ethereum, submitDepositTx.
 *
 * NOTE: the relay step needs a real network (Guardians sign + Wormholescan indexes) — not a bare fork.
 *
 * Env: RPC, CHAIN_ID (Moonbeam); ETH_RPC, ETH_CHAIN_ID (Ethereum); WORMHOLE_API_KEY?
 * Args: --pk --tokenBridge(Moonbeam) --asset(WETH) --receiver(IntentReceiver, Ethereum)
 *       --amount --recipient(dest-chain)   (refund always goes to the signer)
 */
async function main(): Promise<void> {
  const rpcUrl = requiredEnv("RPC");
  const chainId = Number(requiredEnv("CHAIN_ID"));

  const privateKey = requiredArg("--pk") as `0x${string}`;
  const tokenBridge = requiredArg("--tokenBridge"); // Moonbeam Wormhole TokenBridge
  const asset = requiredArg("--asset"); // Moonbeam WETH
  const receiver = requiredArg("--receiver"); // IntentReceiver (Ethereum) — bridge recipient AND redeemer
  const amount = requiredArg("--amount"); // origin deposit amount (smallest unit)
  const recipient = requiredArg("--recipient"); // final dest-chain recipient

  if (!isAddress(tokenBridge)) throw new Error("Invalid --tokenBridge (Moonbeam TokenBridge).");
  if (!isAddress(asset)) throw new Error("Invalid --asset (WETH).");
  if (!isAddress(receiver)) throw new Error("Invalid --receiver (IntentReceiver).");

  const { publicClient, walletClient } = getWallet(rpcUrl, chainId, privateKey);
  const refundTo = privateKeyToAccount(privateKey).address; // always the signer
  const deadline = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  // 1. Quote
  const quoteRequest: QuoteRequest = {
    dry: false,
    swapType: QuoteRequest.swapType.EXACT_INPUT,
    slippageTolerance: SLIPPAGE_BPS,
    originAsset: ORIGIN_ASSET,
    depositType: QuoteRequest.depositType.ORIGIN_CHAIN,
    destinationAsset: DESTINATION_ASSET,
    amount,
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

  // 2. Intent payload — (intentId, depositAddress), 64 bytes, what IntentReceiver.redeem decodes.
  const intentId = keccak256(
    encodeAbiParameters(
      [{ type: "string" }, { type: "address" }, { type: "uint256" }, { type: "string" }],
      [correlationId, depositAddress as `0x${string}`, BigInt(quote.amountIn), deadline],
    ),
  );
  const data = encodeAbiParameters(
    [{ type: "bytes32" }, { type: "address" }],
    [intentId, depositAddress as `0x${string}`],
  );

  // 3. No proxy fee — bridge exactly amountIn (TokenBridge truncates to 8 decimals; sub-1e10-wei dust
  //    stays at the signer). approve, then transferTokensWithPayload → receiver.
  const bridgeAmount = BigInt(quote.amountIn);
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

  // 4. Relay: the payload-3 VAA's emitter is the TokenBridge (LogMessagePublished sender).
  const receipt = await publicClient.getTransactionReceipt({ hash: bridgeTx });
  const published = parseEventLogs({ abi: [LOG_MESSAGE_PUBLISHED], logs: receipt.logs });
  const transfer = published.find((l) => l.args.sender.toLowerCase() === tokenBridge.toLowerCase());
  if (!transfer) {
    throw new Error("No TokenBridge LogMessagePublished in the bridge tx.");
  }

  const sequence = transfer.args.sequence;
  const emitterAddr = pad(tokenBridge as `0x${string}`, { size: 32 })
    .slice(2)
    .toLowerCase();
  console.log(
    `\nPayload-3 VAA: chain=${MOONBEAM_WORMHOLE_ID} emitter=${emitterAddr} seq=${sequence}`,
  );

  const vaa = await fetchVaaHex(
    MOONBEAM_WORMHOLE_ID,
    emitterAddr,
    sequence,
    optionalEnv("WORMHOLE_API_KEY"),
  );
  console.log("  VAA fetched.");

  // 5. IntentReceiver.redeem on Ethereum → completeTransferWithPayload + unwrap + forward native ETH.
  const ethRpc = requiredEnv("ETH_RPC");
  const ethChainId = Number(requiredEnv("ETH_CHAIN_ID"));
  const { publicClient: ethPub, walletClient: ethWallet } = getWallet(
    ethRpc,
    ethChainId,
    privateKey,
  );
  const { abi: receiverAbi } = intentReceiverJson as ifs.ContractArtifact;

  const relayTx = await ethWallet.writeContract({
    address: receiver as `0x${string}`,
    abi: receiverAbi,
    functionName: "redeem",
    args: [vaa],
    gas: 2_000_000n,
  });
  const relayReceipt = await ethPub.waitForTransactionReceipt({ hash: relayTx });
  console.log(`redeem: tx=${relayReceipt.transactionHash} status=${relayReceipt.status}`);

  // redeem forwards (and emits IntentForwarded) atomically or reverts — there is no queue here.
  const forwarded = parseEventLogs({
    abi: receiverAbi,
    eventName: "IntentForwarded",
    logs: relayReceipt.logs,
  }).find(
    (l) =>
      (l.args as { depositAddress: string }).depositAddress.toLowerCase() ===
      depositAddress.toLowerCase(),
  );

  if (!forwarded) {
    throw new Error(
      "redeem succeeded but no IntentForwarded for this depositAddress — investigate.",
    );
  }
  console.log(`Deposit landed → ${depositAddress} (IntentForwarded in ${relayTx}).`);

  // 6. Notify 1Click that the deposit landed (speeds up detection).
  const submit = await OneClickService.submitDepositTx({ depositAddress, txHash: relayTx });
  console.log("submitDepositTx:", JSON.stringify(submit, null, 2));
  console.log(`\nDone. Track 1Click status for ${depositAddress}.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
