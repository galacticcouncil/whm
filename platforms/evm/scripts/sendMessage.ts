import "dotenv/config";

import { createPublicClient, createWalletClient, http, isAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

import { ContractArtifact, SendConfig } from "./interfaces";
import { mnemonicToAccountByAddress } from "./utils";

import messageSenderJson from "../contracts/out/MessageSender.sol/MessageSender.json";

function getConfig(): SendConfig {
  const accountSeed = process.env.ACCOUNT_SEED;
  const accountPk = process.env.ACCOUNT_PK;
  const accountAddress = process.env.ACCOUNT_ADDRESS;

  const rpcUrl = process.env.SENDER_RPC;
  const senderAddress = process.env.SENDER;
  const receiverAddress = process.env.RECEIVER;
  const receiverChainId = process.env.RECEIVER_CHAIN_ID;

  const message = "Hello from the sender!";

  if (!accountAddress) throw new Error("Missing account info. Provide ACCOUNT_ADDRESS.");

  if (!accountSeed && !accountPk)
    throw new Error("Missing account info. Provide ACCOUNT_SEED or ACCOUNT_PK.");

  if (!rpcUrl) throw new Error("Missing SENDER_RPC.");

  if (!senderAddress) throw new Error("Missing sender address. Provide SENDER.");

  if (!receiverAddress) throw new Error("Missing receiver address. Provide RECEIVER.");
  if (!receiverChainId) throw new Error("Missing receiver chain id. Provide TARGET_CHAIN_ID.");

  if (!isAddress(senderAddress)) throw new Error("Invalid sender address.");
  if (!isAddress(receiverAddress)) throw new Error("Invalid receiver address.");

  const targetChainId = Number(receiverChainId);
  if (!Number.isFinite(targetChainId)) {
    throw new Error("Invalid RECEIVER_CHAIN_ID. Provide a wormhole chain id number.");
  }

  const account = accountSeed
    ? mnemonicToAccountByAddress(accountSeed, accountAddress)
    : privateKeyToAccount(accountPk as `0x${string}`);

  return {
    account,
    rpcUrl,
    senderAddress: senderAddress as `0x${string}`,
    receiverAddress: receiverAddress as `0x${string}`,
    targetChainId,
    message,
  };
}

async function main(): Promise<void> {
  const config = getConfig();

  const transport = http(config.rpcUrl);

  const publicClient = createPublicClient({ chain: base, transport });
  const walletClient = createWalletClient({
    account: config.account,
    chain: base,
    transport,
  });

  const { abi } = messageSenderJson as ContractArtifact;

  const txCost = await publicClient.readContract({
    address: config.senderAddress,
    abi,
    functionName: "quoteCrossChainCost",
    args: [config.targetChainId],
  });

  console.log("Transaction cost:", txCost);

  const txHash = await walletClient.writeContract({
    address: config.senderAddress,
    abi,
    functionName: "sendMessage",
    args: [config.targetChainId, config.receiverAddress, config.message],
    value: txCost as bigint,
  });

  console.log("Transaction sent:", txHash);

  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  console.log("Message sent in block:", receipt.blockNumber);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
