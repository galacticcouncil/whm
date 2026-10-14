import type { MigrationStep } from "./types";
import { deployReceiver } from "../../actions/oracle-receiver/deploy";

const step: MigrationStep = {
  name: "003-deploy-receiver",
  description: "Deploy OracleReceiver on Robinhood (Hydration oracle source)",
  action: async (ctx) => {
    const wormholeCore = ctx.env.WORMHOLE_CORE_ROBINHOOD;
    if (!wormholeCore) throw new Error("Missing WORMHOLE_CORE_ROBINHOOD");

    return await deployReceiver({
      ...ctx.wallet.robinhood,
      wormholeCore: wormholeCore as `0x${string}`,
    });
  },
};

export default step;
