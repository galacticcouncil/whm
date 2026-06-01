import type { MigrationConfig } from "../../evm";
import { wallet } from "@whm/common";

const config: MigrationConfig = {
  name: "oracle-emitter-ethereum",
  description: "Deploy OracleEmitter and register wstETH + apyUSD feeds",

  setup: (env, pk) => {
    const rpcUrl = env.RPC;
    const chainId = env.CHAIN_ID;
    if (!rpcUrl) throw new Error("Missing RPC");
    if (!chainId) throw new Error("Missing CHAIN_ID");
    return wallet.getWallet(rpcUrl, Number(chainId), pk as `0x${string}`);
  },
};

export default config;
