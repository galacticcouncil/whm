import type { MigrationStep } from "./types";
import { deployDispatcher } from "../../actions/oracle-dispatcher/deploy";

const step: MigrationStep = {
  name: "002-deploy-dispatcher",
  description: "Deploy OracleDispatcher on Moonbeam",
  action: async (ctx) => {
    const wormholeCore = ctx.env.WORMHOLE_CORE_MOONBEAM;
    if (!wormholeCore) throw new Error("Missing WORMHOLE_CORE_MOONBEAM");

    return await deployDispatcher({
      ...ctx.wallet.moonbeam,
      wormholeCore: wormholeCore as `0x${string}`,
    });
  },
};

export default step;
