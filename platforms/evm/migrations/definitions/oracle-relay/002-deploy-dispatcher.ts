import type { MigrationStep } from "../../types";
import { deployDispatcher } from "../../actions/dispatcher/deploy";

const step: MigrationStep = {
  name: "deploy-dispatcher",
  description: "Deploy MessageDispatcher implementation + UUPS proxy",
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
