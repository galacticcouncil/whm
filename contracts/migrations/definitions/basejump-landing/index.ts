import type { MigrationConfig } from "../../types";
import { wallet } from "../../../lib";

/**
 * Hydration BasejumpLanding contract
 *
 * Env file: migrations/envs/basejump-landing.{env}.env
 */
const config: MigrationConfig = {
  name: "basejump-landing",
  description: "Deploy and configure BasejumpLanding on Hydration",

  setup: (env, pk) => {
    const rpcUrl = env.RPC;
    const chainId = env.CHAIN_ID;
    if (!rpcUrl) throw new Error("Missing RPC");
    if (!chainId) throw new Error("Missing CHAIN_ID");
    return wallet.getWallet(rpcUrl, Number(chainId), pk as `0x${string}`);
  },
};

export default config;
