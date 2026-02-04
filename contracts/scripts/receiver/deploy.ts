import { createPublicClient, createWalletClient, http, pad } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { moonbeam } from "./chain";
import { getConfig } from "./config";

import { ContractArtifact } from "../types";

import messageReceiverJson from "../../out/MessageReceiver.sol/MessageReceiver.json";

async function main(): Promise<void> {
  const config = getConfig();

  const transport = http(config.rpcUrl);

  const account = privateKeyToAccount(config.privateKey);
  const publicClient = createPublicClient({ chain: moonbeam, transport });
  const walletClient = createWalletClient({
    account,
    chain: moonbeam,
    transport,
  });

  const { abi, bytecode } = messageReceiverJson as ContractArtifact;

  const deployHash = await walletClient.deployContract({
    abi,
    bytecode: bytecode.object,
    args: [config.relayer],
  });

  const deployReceipt = await publicClient.waitForTransactionReceipt({ hash: deployHash });
  if (!deployReceipt.contractAddress) {
    throw new Error("Deployment failed! Contract address missing.");
  }

  const receiverAddress = deployReceipt.contractAddress;
  console.log("MessageReceiver deployed to:", receiverAddress);

  const registerHash = await walletClient.writeContract({
    address: receiverAddress,
    abi,
    functionName: "setRegisteredSender",
    args: [config.sourceChainId, pad(config.sender, { size: 32 })],
  });

  await publicClient.waitForTransactionReceipt({ hash: registerHash });
  console.log(`MessageSender registered: ${config.sender} (${config.sourceChainId})`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
