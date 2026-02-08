import "dotenv/config";

import { createPublicClient, createWalletClient, http, isAddress, pad } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { moonbeam } from "./chains";
import { ContractArtifact, ReceiverConfig } from "./interfaces";
import { mnemonicToAccountByAddress } from "./utils";

import messageReceiverJson from "../contracts/out/MessageReceiver.sol/MessageReceiver.json";

function getConfig(): ReceiverConfig {
  const accountSeed = process.env.ACCOUNT_SEED;
  const accountPk = process.env.ACCOUNT_PK;
  const accountAddress = process.env.ACCOUNT_ADDRESS;

  const rpcUrl = process.env.RECEIVER_RPC;
  const relayer = process.env.RECEIVER_RELAYER;

  const sender = process.env.SENDER;
  const senderChainId = process.env.SENDER_CHAIN_ID;

  if (!accountAddress) throw new Error("Missing account info. Provide ACCOUNT_ADDRESS.");

  if (!accountSeed && !accountPk)
    throw new Error("Missing account info. Provide ACCOUNT_SEED or ACCOUNT_PK.");

  if (!rpcUrl) throw new Error("Missing RECEIVER_RPC.");
  if (!relayer) throw new Error("Missing RECEIVER_RELAYER.");
  if (!sender) throw new Error("Missing SENDER.");

  if (!isAddress(relayer)) throw new Error("Invalid receiver relayer address.");
  if (!isAddress(sender)) throw new Error("Invalid sender address.");

  const sourceChainId = Number(senderChainId);
  if (!Number.isFinite(sourceChainId)) {
    throw new Error("Invalid SOURCE_CHAIN_ID. Provide a wormhole chain id number.");
  }

  const account = accountSeed
    ? mnemonicToAccountByAddress(accountSeed, accountAddress)
    : privateKeyToAccount(accountPk as `0x${string}`);
  return {
    account,
    rpcUrl,
    relayer: relayer as `0x${string}`,
    sender: sender as `0x${string}`,
    sourceChainId,
  };
}

async function main(): Promise<void> {
  const config = getConfig();

  const transport = http(config.rpcUrl);

  const publicClient = createPublicClient({ chain: moonbeam, transport });
  const walletClient = createWalletClient({
    account: config.account,
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
  console.log("MessageReceiver owner:", config.account.address);

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
