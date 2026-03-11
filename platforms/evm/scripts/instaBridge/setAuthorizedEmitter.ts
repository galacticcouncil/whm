import "dotenv/config";

import { isAddress } from "viem";

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
  const emitter = requiredArg("--emitter");
  const emitterChain = requiredArg("--emitter-chain");

  if (!isAddress(address)) throw new Error("Invalid contract address.");

  const isBytes32 = emitter.startsWith("0x") && emitter.length === 66;
  if (!isBytes32 && !isAddress(emitter)) {
    throw new Error("Invalid emitter (expected address or bytes32).");
  }

  return {
    rpcUrl,
    chainId: Number(chainId),
    privateKey: privateKey as `0x${string}`,
    address: address as `0x${string}`,
    emitter: emitter as `0x${string}`,
    emitterChain: Number(emitterChain),
  };
}

async function main(): Promise<void> {
  const { address, rpcUrl, chainId, privateKey, emitter, emitterChain } = getConfig();

  const { publicClient, walletClient } = getWallet(rpcUrl, chainId, privateKey);

  const { abi } = instaBridgeJson as ifs.ContractArtifact;

  const txHash = await walletClient.writeContract({
    address,
    abi,
    functionName: "setAuthorizedEmitter",
    args: [emitterChain, emitter],
  });

  await publicClient.waitForTransactionReceipt({ hash: txHash });
  console.log(`Authorized emitter set: emitterChain=${emitterChain}, emitter=${emitter}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
