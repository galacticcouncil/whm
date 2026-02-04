import { isAddress } from "viem";

import { loadEnv } from "../env";
import { getArgValue } from "../utils";

export type DeployConfig = {
  rpcUrl: string;
  privateKey: `0x${string}`;
  relayer: `0x${string}`;
};

export function getConfig(): DeployConfig {
  loadEnv();

  const rpcUrl = getArgValue("--rpc") ?? process.env.RPC_URL;
  const privateKey = getArgValue("--pk") ?? process.env.PRIVATE_KEY;
  const relayer = getArgValue("--relayer") ?? process.env.WHM_RELAYER;

  if (!rpcUrl) throw new Error("Missing RPC URL. Provide --rpc or RPC_URL.");
  if (!privateKey) throw new Error("Missing private key. Provide --pk or PRIVATE_KEY.");
  if (!relayer) {
    throw new Error("Missing relayer address. Provide --relayer or WHM_RELAYER.");
  }
  if (!isAddress(relayer)) throw new Error("Invalid wormhole relayer address.");

  return {
    rpcUrl,
    privateKey: privateKey as `0x${string}`,
    relayer: relayer as `0x${string}`,
  };
}
