import type { MigrationConfig } from "../../types";
import { wallet } from "../../../lib";

/**
 * Full chain stack:
 *   InstaBridge + InstaTransfer + wiring
 *
 * Env file: migrations/envs/insta-bridge.{env}.env
 */
const config: MigrationConfig = {
  name: "insta-bridge",
  description: "Deploy and configure InstaBridge stack on Wormhole chain",

  setup: (env, pk) => {
    const rpcUrl = env.RPC;
    const chainId = env.CHAIN_ID;
    if (!rpcUrl) throw new Error("Missing RPC");
    if (!chainId) throw new Error("Missing CHAIN_ID");
    return wallet.getWallet(rpcUrl, Number(chainId), pk as `0x${string}`);
  },
};

export default config;
