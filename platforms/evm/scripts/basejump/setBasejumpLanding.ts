import "dotenv/config";

import { isAddress, isHex } from "viem";

import { args } from "@whm/common";
import { ifs, wallet } from "../../lib";

import basejumpJson from "../../contracts/out/Basejump.sol/Basejump.json";

const { requiredArg, requiredEnv } = args;
const { getWallet } = wallet;

function getConfig() {
  const rpcUrl = requiredEnv("IBRI_RPC");
  const chainId = requiredEnv("IBRI_CHAIN_ID");

  const privateKey = requiredArg("--pk");
  const address = requiredArg("--address");
  const whChainId = requiredArg("--wh-chain-id");
  const basejumpLanding = requiredArg("--insta-transfer");

  if (!isAddress(address)) throw new Error("Invalid contract address.");
  if (!isHex(basejumpLanding) || basejumpLanding.length !== 66) throw new Error("Invalid insta transfer address (expected bytes32).");

  return {
    rpcUrl,
    chainId: Number(chainId),
    privateKey: privateKey as `0x${string}`,
    address: address as `0x${string}`,
    whChainId: Number(whChainId),
    basejumpLanding: basejumpLanding as `0x${string}`,
  };
}

async function main(): Promise<void> {
  const { address, rpcUrl, chainId, privateKey, whChainId, basejumpLanding } = getConfig();

  const { publicClient, walletClient } = getWallet(rpcUrl, chainId, privateKey);

  const { abi } = basejumpJson as ifs.ContractArtifact;

  const txHash = await walletClient.writeContract({
    address,
    abi,
    functionName: "setBasejumpLanding",
    args: [whChainId, basejumpLanding],
  });

  await publicClient.waitForTransactionReceipt({ hash: txHash });
  console.log(`BasejumpLanding set: chainId=${whChainId}, address=${basejumpLanding}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});