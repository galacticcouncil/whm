import "dotenv/config";

import { createPublicClient, createWalletClient, http, isAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { args } from "@whm/common";
import { ifs, chains } from "../../lib";

import messageReceiverJson from "../../contracts/out/MessageReceiver.sol/MessageReceiver.json";

const { requiredArg, requiredEnv } = args;
const { getChain } = chains;

function parseVaa(vaa: string): `0x${string}` {
  if (vaa.startsWith("0x")) return vaa as `0x${string}`;
  return `0x${Buffer.from(vaa, "base64").toString("hex")}`;
}

function getConfig() {
  const rpcUrl = requiredEnv("RECEIVER_RPC");
  const chainId = requiredEnv("RECEIVER_CHAIN_ID");

  const privateKey = requiredArg("--pk");
  const address = requiredArg("--address");
  const vaa = requiredArg("--vaa");

  if (!isAddress(address)) throw new Error("Invalid receiver address.");

  return {
    rpcUrl,
    chainId: Number(chainId),
    address: address as `0x${string}`,
    privateKey: privateKey as `0x${string}`,
    vaa: parseVaa(vaa),
  };
}

async function main(): Promise<void> {
  const { address, rpcUrl, chainId, privateKey, vaa } = getConfig();

  const account = privateKeyToAccount(privateKey);
  const chain = getChain(chainId);

  const transport = http(rpcUrl);
  const publicClient = createPublicClient({ chain, transport });
  const walletClient = createWalletClient({
    account: account,
    chain,
    transport,
  });

  const { abi } = messageReceiverJson as ifs.ContractArtifact;

  const txHash = await walletClient.writeContract({
    address: address,
    abi,
    functionName: "receiveMessage",
    args: [vaa],
  });

  console.log("Transaction sent:", txHash);

  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  console.log("Message received in block:", receipt.blockNumber);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
