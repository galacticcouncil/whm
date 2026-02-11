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
  const wormholeRelayer = requiredEnv("SENDER_WORMHOLE_RELAYER");

  if (!isAddress(wormholeRelayer)) throw new Error("Invalid wormhole relayer address.");

  const privateKey = requiredArg("--pk");

  return {
    rpcUrl,
    chainId: Number(chainId),
    privateKey: privateKey as `0x${string}`,
    wormholeRelayer: wormholeRelayer as `0x${string}`,
  };
}

async function main(): Promise<void> {
  const { rpcUrl, chainId, privateKey, wormholeRelayer } = getConfig();

  const account = privateKeyToAccount(privateKey);
  const chain = getChain(chainId);

  const transport = http(rpcUrl);
  const publicClient = createPublicClient({ chain, transport });
  const walletClient = createWalletClient({
    account: account,
    chain,
    transport,
  });

  const { abi, bytecode } = messageRelayerJson as ifs.ContractArtifact;

  const deployHash = await walletClient.deployContract({
    abi,
    bytecode: bytecode.object,
    args: [wormholeRelayer],
  });

  const deployReceipt = await publicClient.waitForTransactionReceipt({ hash: deployHash });
  if (!deployReceipt.contractAddress) {
    throw new Error("Deployment failed! Contract address missing.");
  }

  console.log("MessageRelayer deployed to:", deployReceipt.contractAddress);
  console.log("MessageRelayer owner:", account.address);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
