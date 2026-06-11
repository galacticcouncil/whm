import "dotenv/config";

import { isAddress, pad, keccak256, encodeAbiParameters, parseEventLogs } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { OneClickService, QuoteRequest } from "@defuse-protocol/one-click-sdk-typescript";

import { args } from "@whm/common";
import { ifs, wallet } from "@whm/common/evm";
import { fetchVaaHex, LOG_MESSAGE_PUBLISHED } from "@whm/common/wormhole";

import basejumpJson from "../out/Basejump.sol/Basejump.json";
import basejumpProxyJson from "../out/BasejumpProxy.sol/BasejumpProxy.json";
import intentRouterJson from "../out/IntentRouter.sol/IntentRouter.json";

import { bridgeViaWormholeProxy } from "./basejump/bridgeViaWormholeProxy";

const { requiredArg, optionalArg, requiredEnv, optionalEnv } = args;
const { getWallet } = wallet;

const ETHEREUM_WORMHOLE_ID = 2;
const MOONBEAM_WORMHOLE_ID = 16;

const ORIGIN_ASSET = "nep141:eth.omft.near";
const DESTINATION_ASSET = "nep141:wrap.near";
const SLIPPAGE_BPS = 100;

/**
 * End-to-end NIR (Near Intent Routing) leg-2 driver.
 *
 *   1. 1Click quote (ORIGIN_ASSET → DESTINATION_ASSET) → quote-specific Ethereum depositAddress.
 *   2. intentId + (intentId, depositAddress) payload that IntentRouter decodes.
 *   3. Bridge quote.amountIn + proxyFee WETH via BasejumpProxy.bridgeViaWormhole (Moonbeam) → IntentRouter.
 *   4. If --basejump is given: fetch the fast-path VAA from Wormholescan, completeTransfer on
 *      Ethereum (delivers native ETH to depositAddress), then submitDepositTx so 1Click continues.
 *
 * NOTE: the relay step needs a real network (Guardians sign + Wormholescan indexes) — not a bare fork.
 *
 * Env: RPC, CHAIN_ID (Moonbeam); ETH_RPC, ETH_CHAIN_ID (Ethereum, when relaying);
 *      ONECLICK_BASE_URL?, ONECLICK_JWT?, WORMHOLE_API_KEY?
 * Args: --pk --proxy(BasejumpProxy) --asset(WETH) --router(IntentRouter)
 *       --amount --recipient(dest-chain)   (refund always goes to the signer)
 *       [--basejump(Ethereum Basejump) → also relays the Ethereum leg + submitDepositTx]
 */
async function main(): Promise<void> {
  const rpcUrl = requiredEnv("RPC");
  const chainId = Number(requiredEnv("CHAIN_ID"));

  const privateKey = requiredArg("--pk") as `0x${string}`;
  const proxy = requiredArg("--proxy");
  const asset = requiredArg("--asset"); // Moonbeam WETH
  const router = requiredArg("--router"); // IntentRouter (Ethereum)
  const amount = requiredArg("--amount"); // origin deposit amount (smallest unit)
  const recipient = requiredArg("--recipient"); // final dest-chain recipient

  // Pass --basejump (Ethereum Basejump) to also relay the Ethereum leg + submitDepositTx.
  // Its presence IS the relay switch — no separate boolean flag.
  const basejump = optionalArg("--basejump");
  const relay = Boolean(basejump);

  if (!isAddress(proxy)) throw new Error("Invalid --proxy (BasejumpProxy).");
  if (!isAddress(asset)) throw new Error("Invalid --asset (WETH).");
  if (!isAddress(router)) throw new Error("Invalid --router (IntentRouter).");
  if (basejump && !isAddress(basejump)) throw new Error("Invalid --basejump (Ethereum Basejump).");

  // 1Click client config
  const { publicClient } = getWallet(rpcUrl, chainId, privateKey);
  const refundTo = privateKeyToAccount(privateKey).address; // always the signer
  const deadline = new Date(Date.now() + 30 * 60 * 1000).toISOString();

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

  // 2. Intent payload
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

  // 3. WETH bridge amount = quote.amountIn + proxy WETH fee, so the delivered net covers the deposit.
  const { abi: proxyAbi } = basejumpProxyJson as ifs.ContractArtifact;
  const proxyFee = (await publicClient.readContract({
    address: proxy as `0x${string}`,
    abi: proxyAbi,
    functionName: "quoteFee",
    args: [asset],
  })) as bigint;
  const bridgeAmount = BigInt(quote.amountIn) + proxyFee;
  console.log(`  intentId=${intentId}`);
  console.log(`  proxyFee=${proxyFee} bridgeAmount=${bridgeAmount}`);

  // 4. Bridge from Moonbeam → Ethereum IntentRouter
  const bridgeTx = await bridgeViaWormholeProxy({
    rpcUrl,
    chainId,
    privateKey,
    address: proxy as `0x${string}`,
    asset: asset as `0x${string}`,
    amount: bridgeAmount,
    destChain: ETHEREUM_WORMHOLE_ID,
    recipient: pad(router as `0x${string}`, { size: 32 }),
    data,
  });
  console.log(`\nBridge committed on Moonbeam: ${bridgeTx}`);

  if (!relay) {
    console.log(
      `Watch IntentRouter.IntentForwarded on Ethereum, then 1Click status for ${depositAddress}`,
    );
    console.log("(pass --basejump <addr> to also complete the Ethereum leg + submitDepositTx)");
    return;
  }

  // 5. Relay: extract the fast-path VAA sequence (LogMessagePublished where sender == proxy).
  const receipt = await publicClient.getTransactionReceipt({ hash: bridgeTx });
  const published = parseEventLogs({ abi: [LOG_MESSAGE_PUBLISHED], logs: receipt.logs });
  const fast = published.find((l) => l.args.sender.toLowerCase() === proxy.toLowerCase());

  if (!fast) {
    throw new Error("No fast-path LogMessagePublished from the proxy in the bridge tx.");
  }

  const sequence = fast.args.sequence;
  const emitterAddr = pad(proxy as `0x${string}`, { size: 32 })
    .slice(2)
    .toLowerCase();
  console.log(
    `\nFast-path VAA: chain=${MOONBEAM_WORMHOLE_ID} emitter=${emitterAddr} seq=${sequence}`,
  );

  const vaa = await fetchVaaHex(
    MOONBEAM_WORMHOLE_ID,
    emitterAddr,
    sequence,
    optionalEnv("WORMHOLE_API_KEY"),
  );
  console.log("  VAA fetched.");

  // 6. completeTransfer on Ethereum → delivers native ETH to depositAddress via Landing → Router.
  const ethRpc = requiredEnv("ETH_RPC");
  const ethChainId = Number(requiredEnv("ETH_CHAIN_ID"));
  const { publicClient: ethPub, walletClient: ethWallet } = getWallet(
    ethRpc,
    ethChainId,
    privateKey,
  );
  const { abi: basejumpAbi } = basejumpJson as ifs.ContractArtifact;

  const relayTx = await ethWallet.writeContract({
    address: basejump as `0x${string}`,
    abi: basejumpAbi,
    functionName: "completeTransfer",
    args: [vaa],
    gas: 2_000_000n,
  });
  const relayReceipt = await ethPub.waitForTransactionReceipt({ hash: relayTx });
  console.log(`completeTransfer: tx=${relayReceipt.transactionHash} status=${relayReceipt.status}`);

  // 7. The deposit only landed if IntentRouter actually forwarded to depositAddress in THIS tx.
  //    If the landing pool was short on liquidity, transfer() queued instead — completeTransfer
  //    still succeeds, but the ETH lands later via fulfillPending. So gate on IntentForwarded,
  //    not on completeTransfer status.
  const { abi: routerAbi } = intentRouterJson as ifs.ContractArtifact;
  const forwarded = parseEventLogs({
    abi: routerAbi,
    eventName: "IntentForwarded",
    logs: relayReceipt.logs,
  }).find(
    (l) =>
      (l.args as { depositAddress: string }).depositAddress.toLowerCase() ===
      depositAddress.toLowerCase(),
  );

  if (!forwarded) {
    console.log(
      "⚠️  No IntentForwarded in this tx — delivery was QUEUED (landing pool short on liquidity).",
    );
    console.log("    The ETH lands when BasejumpLandingNative.fulfillPending() drains the queue;");
    console.log(`    then call submitDepositTx({ depositAddress, txHash: <that fulfill tx> }).`);
    return;
  }
  console.log(`Deposit landed → ${depositAddress} (IntentForwarded in ${relayTx}).`);

  // 8. Notify 1Click that the deposit landed (speeds up detection).
  const submit = await OneClickService.submitDepositTx({ depositAddress, txHash: relayTx });
  console.log("submitDepositTx:", JSON.stringify(submit, null, 2));
  console.log(`\nDone. Track 1Click status for ${depositAddress}.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
