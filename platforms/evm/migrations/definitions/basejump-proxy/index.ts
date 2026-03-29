import type { MigrationConfig } from "../../types";
import { wallet } from "../../../lib";

/**
 * Full Moonbeam stack:
 *   XcmTransactor + BasejumpProxy + wiring
 *
 * Env file: migrations/envs/basejump-proxy.{env}.env
 */
const config: MigrationConfig = {
  name: "basejump-proxy",
  description: "Deploy and configure BasejumpProxy stack on Moonbeam",

  setup: (env, pk) => {
    const rpcUrl = env.RPC;
    const chainId = env.CHAIN_ID;
    if (!rpcUrl) throw new Error("Missing RPC");
    if (!chainId) throw new Error("Missing CHAIN_ID");
    return wallet.getWallet(rpcUrl, Number(chainId), pk as `0x${string}`);
  },
};

export default config;
