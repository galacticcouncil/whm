import "dotenv/config";

import { OneClickService, QuoteRequest } from "@defuse-protocol/one-click-sdk-typescript";

import { args } from "@whm/common";
import { wallet } from "../../lib";

const { requiredArg, requiredEnv } = args;
const { getWallet } = wallet;

const BASE_CHAIN_ID = 8453;
const USDC_ON_BASE = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" as const;
const AMOUNT = 350_000n; // 0.35 USDC (6 decimals)
const WALLET = "0x" as const;

const ERC20_ABI = [
  {
    name: "transfer",
    type: "function",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable",
  },
] as const;

async function main(): Promise<void> {
  const pk = requiredArg("--pk") as `0x${string}`;
  const rpcUrl = requiredEnv("RPC");

  const quoteRequest: QuoteRequest = {
    dry: false,
    swapType: QuoteRequest.swapType.EXACT_INPUT,
    slippageTolerance: 100,
    originAsset: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
    depositType: QuoteRequest.depositType.ORIGIN_CHAIN,
    destinationAsset: "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near",
    amount: AMOUNT.toString(),
    refundTo: WALLET,
    refundType: QuoteRequest.refundType.ORIGIN_CHAIN,
    recipient: WALLET,
    recipientType: QuoteRequest.recipientType.DESTINATION_CHAIN,
    deadline: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
  };

  console.log("Quote:");
  const quote = await OneClickService.getQuote(quoteRequest);
  console.log(JSON.stringify(quote, null, 2));

  const depositAddress = quote.quote.depositAddress;
  if (!depositAddress) throw new Error("No depositAddress in quote response.");

  const { publicClient, walletClient } = getWallet(rpcUrl, BASE_CHAIN_ID, pk);

  const txHash = await walletClient.writeContract({
    address: USDC_ON_BASE,
    abi: ERC20_ABI,
    functionName: "transfer",
    args: [depositAddress as `0x${string}`, AMOUNT],
  });
  await publicClient.waitForTransactionReceipt({ hash: txHash });
  console.log("\nDeposit tx:", txHash);

  console.log("\nSubmit:");
  const submit = await OneClickService.submitDepositTx({
    depositAddress,
    txHash,
  });
  console.log(JSON.stringify(submit, null, 2));

  console.log("\nStatus:");
  const status = await OneClickService.getExecutionStatus(depositAddress);
  console.log(JSON.stringify(status, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
