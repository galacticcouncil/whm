import type { MigrationConfig } from "../../types";
import { wallet } from "../../../lib";

/**
 * Hydration InstaTransfer contract
 *
 * Env file: migrations/envs/insta-transfer.{env}.env
 */
const config: MigrationConfig = {
  name: "insta-transfer",
  description: "Deploy and configure InstaTransfer on Hydration",

  setup: (env, pk) => {
    const rpcUrl = env.RPC;
    const chainId = env.CHAIN_ID;
    if (!rpcUrl) throw new Error("Missing RPC");
    if (!chainId) throw new Error("Missing CHAIN_ID");
    return wallet.getWallet(rpcUrl, Number(chainId), pk as `0x${string}`);
  },
};

export default config;
