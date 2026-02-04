import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

import { getConfig } from "./config";

import { ContractArtifact } from "../types";
import messageSenderJson from "../../out/MessageSender.sol/MessageSender.json";

async function main(): Promise<void> {
  const config = getConfig();

  const account = privateKeyToAccount(config.privateKey);
  const publicClient = createPublicClient({ chain: base, transport: http(config.rpcUrl) });
  const walletClient = createWalletClient({
    account,
    chain: base,
    transport: http(config.rpcUrl),
  });

  const { abi, bytecode } = messageSenderJson as ContractArtifact;

  const deployHash = await walletClient.deployContract({
    abi,
    bytecode: bytecode.object,
    args: [config.relayer],
  });

  const deployReceipt = await publicClient.waitForTransactionReceipt({ hash: deployHash });
  if (!deployReceipt.contractAddress) {
    throw new Error("Deployment failed! Contract address missing.");
  }

  console.log("MessageSender deployed to:", deployReceipt.contractAddress);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
