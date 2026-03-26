import "dotenv/config";

import { isAddress, isHex } from "viem";

import { args } from "@whm/common";
import { ifs, wallet } from "../../lib";

import instaBridgeJson from "../../contracts/out/InstaBridge.sol/InstaBridge.json";

const { requiredArg, requiredEnv } = args;
const { getWallet } = wallet;

function getConfig() {
  const rpcUrl = requiredEnv("RPC");
  const chainId = requiredEnv("CHAIN_ID");

  const privateKey = requiredArg("--pk");
  const address = requiredArg("--address");
  const asset = requiredArg("--asset");
  const amount = requiredArg("--amount");
  const destChain = requiredArg("--dest-chain");
  const destAsset = requiredArg("--dest-asset");
  const recipient = requiredArg("--recipient");

  if (!isAddress(address)) throw new Error("Invalid contract address.");
  if (!isAddress(asset)) throw new Error("Invalid asset address.");
  if (!isAddress(destAsset)) throw new Error("Invalid dest asset address.");
  if (!isHex(recipient) || recipient.length !== 66)
    throw new Error("Invalid recipient (expected bytes32).");

  return {
    rpcUrl,
    chainId: Number(chainId),
    privateKey: privateKey as `0x${string}`,
    address: address as `0x${string}`,
    asset: asset as `0x${string}`,
    amount: BigInt(amount),
    destChain: Number(destChain),
    destAsset: destAsset as `0x${string}`,
    recipient: recipient as `0x${string}`,
  };
}

async function main(): Promise<void> {
  const { address, rpcUrl, chainId, privateKey, asset, amount, destChain, destAsset, recipient } =
    getConfig();

  const { publicClient, walletClient } = getWallet(rpcUrl, chainId, privateKey);

  const { abi } = instaBridgeJson as ifs.ContractArtifact;

  // Approve
  const erc20Abi = [
    {
      name: "approve",
      type: "function",
      inputs: [
        { name: "spender", type: "address" },
        { name: "amount", type: "uint256" },
      ],
      outputs: [{ name: "", type: "bool" }],
      stateMutability: "nonpayable",
    },
  ] as const;

  const approveHash = await walletClient.writeContract({
    address: asset,
    abi: erc20Abi,
    functionName: "approve",
    args: [address, amount],
  });
  await publicClient.waitForTransactionReceipt({ hash: approveHash });
  console.log("Approved:", approveHash);

  // Wormhole message fee
  const wormholeAddr = (await publicClient.readContract({
    address,
    abi,
    functionName: "wormhole",
  })) as `0x${string}`;

  const wormholeAbi = [
    {
      name: "messageFee",
      type: "function",
      inputs: [],
      outputs: [{ name: "", type: "uint256" }],
      stateMutability: "view",
    },
  ] as const;

  const fee = (await publicClient.readContract({
    address: wormholeAddr,
    abi: wormholeAbi,
    functionName: "messageFee",
  })) as bigint;

  // Bridge
  const txHash = await walletClient.writeContract({
    address,
    abi,
    functionName: "bridgeViaWormhole",
    args: [asset, amount, destChain, destAsset, recipient],
    value: fee,
  });

  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  console.log(`Bridge initiated: tx=${receipt.transactionHash}`);
  console.log(`  asset=${asset}, amount=${amount}`);
  console.log(`  destChain=${destChain}, destAsset=${destAsset}, recipient=${recipient}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
