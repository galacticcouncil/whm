import { isAddress } from "viem";

import { loadEnv } from "../env";
import { getArgValue } from "../utils";

export type DeployConfig = {
  rpcUrl: string;
  privateKey: `0x${string}`;
  relayer: `0x${string}`;
  sender: `0x${string}`;
  sourceChainId: number;
};

export function getConfig(): DeployConfig {
  loadEnv();

  const rpcUrl = getArgValue("--rpc") ?? process.env.RPC_URL;
  const privateKey = getArgValue("--pk") ?? process.env.PRIVATE_KEY;
  const relayer = getArgValue("--relayer") ?? process.env.WHM_RELAYER;
  const sender = getArgValue("--sender") ?? process.env.WHM_SENDER;
  const sourceChainIdRaw = getArgValue("--source-chain-id") ?? process.env.SOURCE_CHAIN_ID;

  if (!rpcUrl) throw new Error("Missing RPC URL. Provide --rpc or RPC_URL.");
  if (!privateKey) throw new Error("Missing private key. Provide --pk or PRIVATE_KEY.");
  if (!relayer) {
    throw new Error("Missing relayer address. Provide --relayer or WHM_RELAYER.");
  }
  if (!sender) {
    throw new Error("Missing sender address. Provide --sender or WHM_SENDER.");
  }

  if (!isAddress(relayer)) throw new Error("Invalid wormhole relayer address.");
  if (!isAddress(sender)) throw new Error("Invalid wormhole sender address.");

  const sourceChainId = Number(sourceChainIdRaw);
  if (!Number.isFinite(sourceChainId)) {
    throw new Error(
      "Invalid source chain id. Provide a number via --source-chain-id or SOURCE_CHAIN_ID.",
    );
  }

  return {
    rpcUrl,
    privateKey: privateKey as `0x${string}`,
    relayer: relayer as `0x${string}`,
    sender: sender as `0x${string}`,
    sourceChainId,
  };
}
