import "dotenv/config";

import { createPublicClient, createWalletClient, http, isAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { utils, ifs, chains } from "../../lib";

import messageReceiverJson from "../../contracts/out/MessageReceiver.sol/MessageReceiver.json";

const { getChain } = chains;
const { requiredArg, requiredEnv } = utils;

function getConfig() {
  const rpcUrl = requiredEnv("RECEIVER_RPC");
  const wormholeRelayer = requiredEnv("RECEIVER_WORMHOLE_RELAYER");
  const wormholeCore = requiredEnv("RECEIVER_WORMHOLE_CORE");
  const chainId = requiredEnv("RECEIVER_CHAIN_ID");

  if (!isAddress(wormholeRelayer)) throw new Error("Invalid wormhole relayer address.");
  if (!isAddress(wormholeCore)) throw new Error("Invalid wormhole core address.");

  const privateKey = requiredArg("--pk");

  return {
    rpcUrl,
    chainId: Number(chainId),
    privateKey: privateKey as `0x${string}`,
    wormholeRelayer: wormholeRelayer as `0x${string}`,
    wormholeCore: wormholeCore as `0x${string}`,
  };
}

async function main(): Promise<void> {
  const { rpcUrl, chainId, privateKey, wormholeCore, wormholeRelayer } = getConfig();

  const account = privateKeyToAccount(privateKey);
  const chain = getChain(chainId);

  const transport = http(rpcUrl);
  const publicClient = createPublicClient({ chain, transport });
  const walletClient = createWalletClient({
    account: account,
    chain,
    transport,
  });

  const { abi, bytecode } = messageReceiverJson as ifs.ContractArtifact;

  const deployHash = await walletClient.deployContract({
    abi,
    bytecode: bytecode.object,
    args: [wormholeRelayer, wormholeCore],
  });

  const deployReceipt = await publicClient.waitForTransactionReceipt({ hash: deployHash });
  if (!deployReceipt.contractAddress) {
    throw new Error("Deployment failed! Contract address missing.");
  }

  const receiverAddress = deployReceipt.contractAddress;
  console.log("MessageReceiver deployed to:", receiverAddress);
  console.log("MessageReceiver owner:", account.address);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
