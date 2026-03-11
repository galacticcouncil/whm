import "dotenv/config";

import { isAddress } from "viem";

import { args } from "@whm/common";
import { ifs, wallet } from "../../lib";

import instaTransferJson from "../../contracts/out/InstaTransfer.sol/InstaTransfer.json";

const { requiredArg, requiredEnv } = args;
const { getWallet } = wallet;

function getConfig() {
  const rpcUrl = requiredEnv("INSTA_TRANSFER_RPC");
  const chainId = requiredEnv("INSTA_TRANSFER_CHAIN_ID");

  const privateKey = requiredEnv("PRIVATE_KEY");
  const proxyAddress = requiredArg("--proxy");
  const bridgeAddress = requiredArg("--bridge");
  const enabled = requiredArg("--enabled");

  if (!isAddress(proxyAddress)) throw new Error("Invalid --proxy address.");
  if (!isAddress(bridgeAddress)) throw new Error("Invalid --bridge address.");
  if (enabled !== "true" && enabled !== "false") throw new Error("--enabled must be 'true' or 'false'.");

  return {
    rpcUrl,
    chainId: Number(chainId),
    privateKey: privateKey as `0x${string}`,
    proxyAddress: proxyAddress as `0x${string}`,
    bridgeAddress: bridgeAddress as `0x${string}`,
    enabled: enabled === "true",
  };
}

async function main(): Promise<void> {
  const { rpcUrl, chainId, privateKey, proxyAddress, bridgeAddress, enabled } = getConfig();

  const { publicClient, walletClient } = getWallet(rpcUrl, chainId, privateKey);

  const { abi } = instaTransferJson as ifs.ContractArtifact;

  const hash = await walletClient.writeContract({
    address: proxyAddress,
    abi,
    functionName: "setAuthorizedBridge",
    args: [bridgeAddress, enabled],
  });

  await publicClient.waitForTransactionReceipt({ hash });

  console.log(`InstaTransfer ${proxyAddress}: setAuthorizedBridge(${bridgeAddress}, ${enabled})`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});