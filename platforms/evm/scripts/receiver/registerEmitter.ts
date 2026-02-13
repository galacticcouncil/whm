import "dotenv/config";

import { createPublicClient, createWalletClient, http, isAddress, pad } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { args } from "@nohaapav/whm-sdk";
import { ifs, chains } from "../../lib";

import messageReceiverJson from "../../contracts/out/MessageReceiver.sol/MessageReceiver.json";

const { requiredArg, requiredEnv } = args;
const { getChain } = chains;

function getConfig() {
  const rpcUrl = requiredEnv("RECEIVER_RPC");
  const chainId = requiredEnv("RECEIVER_CHAIN_ID");

  const privateKey = requiredArg("--pk");
  const address = requiredArg("--address");
  const emitter = requiredArg("--emitter");
  const sourceChain = requiredArg("--source-chain");

  if (!isAddress(address)) throw new Error("Invalid receiver address.");

  const isBytes32 = emitter.startsWith("0x") && emitter.length === 66;
  if (!isBytes32 && !isAddress(emitter)) {
    throw new Error("Invalid emitter (expected address or bytes32).");
  }

  return {
    rpcUrl,
    chainId: Number(chainId),
    address: address as `0x${string}`,
    privateKey: privateKey as `0x${string}`,
    emitterBytes32: isBytes32
      ? (emitter as `0x${string}`)
      : pad(emitter as `0x${string}`, { size: 32 }),
    sourceChain,
  };
}

async function main(): Promise<void> {
  const { address, rpcUrl, chainId, privateKey, emitterBytes32, sourceChain } = getConfig();

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
    functionName: "setRegisteredEmitter",
    args: [sourceChain, emitterBytes32],
  });

  await publicClient.waitForTransactionReceipt({ hash: registerHash });
  console.log(`MessageEmitter registered: ${emitterBytes32} (${sourceChain})`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
