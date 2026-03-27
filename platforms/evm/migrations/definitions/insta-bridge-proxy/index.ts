import type { MigrationConfig } from "../../types";
import { wallet } from "../../../lib";

/**
 * Full Moonbeam stack:
 *   XcmTransactor + InstaBridgeProxy + wiring
 *
 * Env file: migrations/envs/insta-bridge-proxy.{env}.env
 */
const config: MigrationConfig = {
  name: "insta-bridge-proxy",
  description: "Deploy and configure InstaBridgeProxy stack on Moonbeam",

  setup: (env, pk) => {
    const rpcUrl = env.RPC;
    const chainId = env.CHAIN_ID;
    if (!rpcUrl) throw new Error("Missing RPC");
    if (!chainId) throw new Error("Missing CHAIN_ID");
    return wallet.getWallet(rpcUrl, Number(chainId), pk as `0x${string}`);
  },
};

export default config;
