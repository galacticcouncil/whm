import "dotenv/config";

import { createPublicClient, createWalletClient, http, isAddress, pad } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { utils, ifs, chains } from "../../lib";

import messageReceiverJson from "../../contracts/out/MessageReceiver.sol/MessageReceiver.json";

const { getChain } = chains;
const { requiredArg, requiredEnv } = utils;

function getConfig() {
  const rpcUrl = requiredEnv("RECEIVER_RPC");
  const chainId = requiredEnv("RECEIVER_CHAIN_ID");

  const privateKey = requiredArg("--pk");
  const address = requiredArg("--address");
  const sender = requiredArg("--sender");
  const sourceChain = requiredArg("--source-chain");

  if (!isAddress(address)) throw new Error("Invalid receiver address.");
  if (!isAddress(sender)) throw new Error("Invalid sender address.");

  return {
    rpcUrl,
    chainId: Number(chainId),
    address: address as `0x${string}`,
    privateKey: privateKey as `0x${string}`,
    sender: sender as `0x${string}`,
    sourceChain,
  };
}

async function main(): Promise<void> {
  const { address, rpcUrl, chainId, privateKey, sender, sourceChain } = getConfig();

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

  const registerHash = await walletClient.writeContract({
    address: address,
    abi,
    functionName: "setRegisteredSender",
    args: [sourceChain, pad(sender, { size: 32 })],
  });

  await publicClient.waitForTransactionReceipt({ hash: registerHash });
  console.log(`MessageSender registered: ${sender} (${sourceChain})`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
