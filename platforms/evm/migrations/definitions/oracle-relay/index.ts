import type { MigrationConfig } from "../../types";
import { wallet } from "../../../lib";

/**
 * Full Moonbeam oracle relay stack:
 *   XcmTransactor + MessageDispatcher + wiring
 *
 * Messages: Solana emitter → Wormhole → Moonbeam dispatcher → XCM transact → Hydration
 *
 * Env file: migrations/envs/oracle-relay.{env}.env
 */
const config: MigrationConfig = {
  name: "oracle-relay",
  description: "Deploy and configure Moonbeam oracle relay stack (transactor + dispatcher)",

  setup: (env, pk) => {
    const rpcUrl = env.RPC;
    const chainId = env.CHAIN_ID;
    if (!rpcUrl) throw new Error("Missing RPC");
    if (!chainId) throw new Error("Missing CHAIN_ID");
    return wallet.getWallet(rpcUrl, Number(chainId), pk);
  },
};

export default config;
