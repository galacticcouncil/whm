import "dotenv/config";

import { createPublicClient, createWalletClient, http, isAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { chains, utils, ifs } from "../../lib";

import messageRelayerJson from "../../contracts/out/MessageRelayer.sol/MessageRelayer.json";

const { getChain } = chains;
const { requiredArg, requiredEnv } = utils;

function getConfig() {
  const rpcUrl = requiredEnv("SENDER_RPC");
  const chainId = requiredEnv("SENDER_CHAIN_ID");

  const privateKey = requiredArg("--pk");
  const address = requiredArg("--address");
  const receiver = requiredArg("--receiver");
  const targetChain = requiredArg("--target-chain");
  const message = requiredArg("--message");

  if (!isAddress(address)) throw new Error("Invalid sender address.");
  if (!isAddress(receiver)) throw new Error("Invalid receiver address.");

  return {
    rpcUrl,
    chainId: Number(chainId),
    address: address as `0x${string}`,
    privateKey: privateKey as `0x${string}`,
    receiver: receiver as `0x${string}`,
    targetChain,
    message,
  };
}

async function main(): Promise<void> {
  const { address, rpcUrl, chainId, privateKey, receiver, targetChain, message } = getConfig();

  const account = privateKeyToAccount(privateKey);
  const chain = getChain(chainId);

  const transport = http(rpcUrl);
  const publicClient = createPublicClient({ chain, transport });
  const walletClient = createWalletClient({
    account: account,
    chain,
    transport,
  });

  const { abi } = messageRelayerJson as ifs.ContractArtifact;

  const txCost = await publicClient.readContract({
    address: address,
    abi,
    functionName: "quoteCrossChainCost",
    args: [targetChain],
  });

  console.log("Transaction cost:", txCost);

  const txHash = await walletClient.writeContract({
    address: address,
    abi,
    functionName: "sendMessage",
    args: [targetChain, receiver, message],
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
