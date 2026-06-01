import type { MigrationStep } from "../../evm";
import { deployDispatcher } from "../../actions/oracle-dispatcher/deploy";

const step: MigrationStep = {
  name: "deploy-dispatcher",
  description: "Deploy OracleDispatcher implementation + UUPS proxy (Ethereum stack)",
  action: async (ctx) => {
    const wormholeCore = ctx.env.WORMHOLE_CORE;
    if (!wormholeCore) throw new Error("Missing WORMHOLE_CORE");

    return await deployDispatcher({
      ...ctx.wallet,
      wormholeCore: wormholeCore as `0x${string}`,
    });
  },
};

export default step;
