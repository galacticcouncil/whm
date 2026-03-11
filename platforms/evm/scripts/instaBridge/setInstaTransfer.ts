import "dotenv/config";

import { isAddress, isHex } from "viem";

import { args } from "@whm/common";
import { ifs, wallet } from "../../lib";

import instaBridgeJson from "../../contracts/out/InstaBridge.sol/InstaBridge.json";

const { requiredArg, requiredEnv } = args;
const { getWallet } = wallet;

function getConfig() {
  const rpcUrl = requiredEnv("IBRI_RPC");
  const chainId = requiredEnv("IBRI_CHAIN_ID");

  const privateKey = requiredArg("--pk");
  const address = requiredArg("--address");
  const whChainId = requiredArg("--wh-chain-id");
  const instaTransfer = requiredArg("--insta-transfer");

  if (!isAddress(address)) throw new Error("Invalid contract address.");
  if (!isHex(instaTransfer) || instaTransfer.length !== 66) throw new Error("Invalid insta transfer address (expected bytes32).");

  return {
    rpcUrl,
    chainId: Number(chainId),
    privateKey: privateKey as `0x${string}`,
    address: address as `0x${string}`,
    whChainId: Number(whChainId),
    instaTransfer: instaTransfer as `0x${string}`,
  };
}

async function main(): Promise<void> {
  const { address, rpcUrl, chainId, privateKey, whChainId, instaTransfer } = getConfig();

  const { publicClient, walletClient } = getWallet(rpcUrl, chainId, privateKey);

  const { abi } = instaBridgeJson as ifs.ContractArtifact;

  const txHash = await walletClient.writeContract({
    address,
    abi,
    functionName: "setInstaTransfer",
    args: [whChainId, instaTransfer],
  });

  await publicClient.waitForTransactionReceipt({ hash: txHash });
  console.log(`InstaTransfer set: chainId=${whChainId}, address=${instaTransfer}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});