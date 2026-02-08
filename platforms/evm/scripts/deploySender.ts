import "dotenv/config";

import { createPublicClient, createWalletClient, http, isAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

import { ContractArtifact, SenderConfig } from "./interfaces";
import { mnemonicToAccountByAddress } from "./utils";

import messageSenderJson from "../contracts/out/MessageSender.sol/MessageSender.json";

function getConfig(): SenderConfig {
  const accountSeed = process.env.ACCOUNT_SEED;
  const accountPk = process.env.ACCOUNT_PK;
  const accountAddress = process.env.ACCOUNT_ADDRESS;

  const rpcUrl = process.env.SENDER_RPC;
  const relayer = process.env.SENDER_RELAYER;

  if (!accountAddress) throw new Error("Missing account info. Provide ACCOUNT_ADDRESS.");

  if (!accountSeed && !accountPk)
    throw new Error("Missing account info. Provide ACCOUNT_SEED or ACCOUNT_PK.");

  if (!rpcUrl) throw new Error("Missing SENDER_RPC.");
  if (!relayer) throw new Error("Missing SENDER_RELAYER.");

  if (!isAddress(relayer)) throw new Error("Invalid sender relayer address.");

  const account = accountSeed
    ? mnemonicToAccountByAddress(accountSeed, accountAddress)
    : privateKeyToAccount(accountPk as `0x${string}`);
  return {
    account,
    rpcUrl,
    relayer: relayer as `0x${string}`,
  };
}

async function main(): Promise<void> {
  const config = getConfig();

  const publicClient = createPublicClient({ chain: base, transport: http(config.rpcUrl) });
  const walletClient = createWalletClient({
    account: config.account,
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
  console.log("MessageSender owner:", config.account.address);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
