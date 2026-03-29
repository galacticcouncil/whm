import type { MigrationConfig } from "../../types";
import { wallet } from "../../../lib";

/**
 * Full chain stack:
 *   Basejump + BasejumpLanding + wiring
 *
 * Env file: migrations/envs/basejump.{env}.env
 */
const config: MigrationConfig = {
  name: "basejump",
  description: "Deploy and configure Basejump stack on Wormhole chain",

  setup: (env, pk) => {
    const rpcUrl = env.RPC;
    const chainId = env.CHAIN_ID;
    if (!rpcUrl) throw new Error("Missing RPC");
    if (!chainId) throw new Error("Missing CHAIN_ID");
    return wallet.getWallet(rpcUrl, Number(chainId), pk as `0x${string}`);
  },
};

export default config;
