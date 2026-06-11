import "dotenv/config";

import { isAddress, isHex, pad } from "viem";

import { args } from "@whm/common";
import { ifs, wallet } from "@whm/common/evm";

import basejumpProxyJson from "../../out/BasejumpProxy.sol/BasejumpProxy.json";

const { requiredArg, optionalArg, requiredEnv } = args;
const { getWallet } = wallet;

// Default destination wormhole id for the Intents leg (Ethereum). Matches IntentEmitter.ETHEREUM_WORMHOLE_ID.
const ETHEREUM_WORMHOLE_ID = 2;

export type BridgeViaWormholeProxyParams = {
  rpcUrl: string;
  chainId: number;
  privateKey: `0x${string}`;
  address: `0x${string}`; // BasejumpProxy
  asset: `0x${string}`; // ERC20 to bridge (e.g. Moonbeam WETH)
  amount: bigint;
  destChain: number; // destination wormhole id
  recipient: `0x${string}`; // bytes32 recipient on the destination chain
  data: `0x${string}`; // opaque payload; "0x" (empty) = normal flow, no receiver callback
};

/**
 * Approve `asset` to the proxy and call
 *   BasejumpProxy.bridgeViaWormhole(asset, amount, destChain, recipient, data)
 * paying the wormhole message fee. Reusable by higher-level scripts (e.g. the 1Click
 * intent trigger). With empty `data` this is a plain Basejump bridge; with a
 * `(intentId, depositAddress)` payload + an IntentRouter recipient it drives the Intents leg.
 */
export async function bridgeViaWormholeProxy(
  params: BridgeViaWormholeProxyParams,
): Promise<`0x${string}`> {
  const { publicClient, walletClient } = getWallet(params.rpcUrl, params.chainId, params.privateKey);
  const { abi } = basejumpProxyJson as ifs.ContractArtifact;

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
    address: params.asset,
    abi: erc20Abi,
    functionName: "approve",
    args: [params.address, params.amount],
  });
  await publicClient.waitForTransactionReceipt({ hash: approveHash });
  console.log("Approved:", approveHash);

  // Wormhole message fee (paid by _fastTrack's publishMessage).
  const wormholeAddr = (await publicClient.readContract({
    address: params.address,
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

  const txHash = await walletClient.writeContract({
    address: params.address,
    abi,
    functionName: "bridgeViaWormhole",
    args: [params.asset, params.amount, params.destChain, params.recipient, params.data],
    value: fee,
  });

  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  console.log(`Bridge initiated: tx=${receipt.transactionHash}`);
  console.log(`  asset=${params.asset} amount=${params.amount} destChain=${params.destChain}`);
  console.log(`  recipient=${params.recipient}`);
  console.log(`  data=${params.data === "0x" ? "(none — normal flow)" : params.data}`);
  return receipt.transactionHash;
}

/** Normalize a 20-byte address or a 32-byte hex into a bytes32 recipient. */
function toBytes32(value: string): `0x${string}` {
  if (isAddress(value)) return pad(value as `0x${string}`, { size: 32 });
  if (isHex(value) && value.length === 66) return value as `0x${string}`;
  throw new Error("Invalid --recipient (expected an address or bytes32).");
}

function getConfig(): BridgeViaWormholeProxyParams {
  const address = requiredArg("--address"); // BasejumpProxy
  const asset = requiredArg("--asset");
  const recipient = requiredArg("--recipient"); // dest recipient (address or bytes32)
  const dataArg = optionalArg("--data"); // opaque payload; omit for normal flow
  const destChainArg = optionalArg("--destChain");

  if (!isAddress(address)) throw new Error("Invalid --address (BasejumpProxy).");
  if (!isAddress(asset)) throw new Error("Invalid --asset.");
  if (dataArg && !isHex(dataArg)) throw new Error("Invalid --data (expected hex).");

  return {
    rpcUrl: requiredEnv("RPC"),
    chainId: Number(requiredEnv("CHAIN_ID")),
    privateKey: requiredArg("--pk") as `0x${string}`,
    address: address as `0x${string}`,
    asset: asset as `0x${string}`,
    amount: BigInt(requiredArg("--amount")),
    destChain: destChainArg ? Number(destChainArg) : ETHEREUM_WORMHOLE_ID,
    recipient: toBytes32(recipient),
    data: (dataArg as `0x${string}`) ?? "0x",
  };
}

// Standalone entry — only runs when invoked directly, so the function above stays importable.
if (require.main === module) {
  bridgeViaWormholeProxy(getConfig()).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
