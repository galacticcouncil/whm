import "dotenv/config";

import { createPublicClient, createWalletClient, http, isAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { args } from "../../../../common";
import { chains, ifs } from "../../lib";

import xcmTransactorJson from "../../contracts/out/XcmTransactor.sol/XcmTransactor.json";

const { requiredArg, optionalArg, requiredEnv } = args;
const { getChain } = chains;

function getConfig() {
  const rpcUrl = requiredEnv("RECEIVER_RPC");
  const chainId = requiredEnv("RECEIVER_CHAIN_ID");

  const privateKey = requiredArg("--pk");
  const address = requiredArg("--address");
  const dispatcher = requiredArg("--dispatcher");
  const enabledArg = optionalArg("--enabled");

  if (!isAddress(address)) throw new Error("Invalid transactor address.");
  if (!isAddress(dispatcher)) throw new Error("Invalid dispatcher address.");

  return {
    rpcUrl,
    chainId: Number(chainId),
    address: address as `0x${string}`,
    privateKey: privateKey as `0x${string}`,
    dispatcher: dispatcher as `0x${string}`,
    enabled: enabledArg === "true",
  };
}

async function main(): Promise<void> {
  const { address, rpcUrl, chainId, privateKey, dispatcher, enabled } = getConfig();

  const account = privateKeyToAccount(privateKey);
  const chain = getChain(chainId);

  const transport = http(rpcUrl);
  const publicClient = createPublicClient({ chain, transport });
  const walletClient = createWalletClient({
    account: account,
    chain,
    transport,
  });

  const { abi } = xcmTransactorJson as ifs.ContractArtifact;

  const txHash = await walletClient.writeContract({
    address: address,
    abi,
    functionName: "setAuthorized",
    args: [dispatcher, enabled],
  });

  await publicClient.waitForTransactionReceipt({ hash: txHash });
  console.log(`Dispatcher authorization ${enabled ? "granted" : "removed"}: ${dispatcher}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
