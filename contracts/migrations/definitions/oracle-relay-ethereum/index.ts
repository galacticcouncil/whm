import type { MigrationConfig } from "../../types";
import { wallet } from "@whm/common";

// Parallel Moonbeam oracle relay stack scoped to Ethereum-sourced VAAs.
// The original `oracle-relay` stack (Solana → Moonbeam) has been renounced
// to a zero owner, so adding Ethereum as a new source requires a fresh
// XcmTransactor + OracleDispatcher proxy pair, not a config call.
//
// Reads ethEmitter proxy from the `oracle-emitter` migration via ctx.ref —
// cross-env override via EMITTER_ENV.
const config: MigrationConfig = {
  name: "oracle-relay-ethereum",
  description: "Deploy a Moonbeam oracle relay stack dedicated to the Ethereum source",

  setup: (env, pk) => {
    const rpcUrl = env.RPC;
    const chainId = env.CHAIN_ID;
    if (!rpcUrl) throw new Error("Missing RPC");
    if (!chainId) throw new Error("Missing CHAIN_ID");
    return wallet.getWallet(rpcUrl, Number(chainId), pk as `0x${string}`);
  },
};

export default config;
