import type { MigrationConfig } from "../../types";
import { wallet } from "../../../lib";

/**
 * Per-chain wiring of BasejumpProxy:
 *   - Authorize source chain emitter
 *   - Set landing mapping for source chain
 *
 * Runs once per source chain (e.g. base, ethereum).
 * Env file: migrations/envs/{env}/basejump-proxy-setup.env
 */
const config: MigrationConfig = {
  name: "basejump-proxy-setup",
  description: "Wire BasejumpProxy for a source chain",

  setup: (env, pk) => {
    const rpcUrl = env.RPC;
    const chainId = env.CHAIN_ID;
    if (!rpcUrl) throw new Error("Missing RPC");
    if (!chainId) throw new Error("Missing CHAIN_ID");
    return wallet.getWallet(rpcUrl, Number(chainId), pk as `0x${string}`);
  },
};

export default config;
