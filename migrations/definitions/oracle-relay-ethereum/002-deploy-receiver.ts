import type { MigrationStep } from "./types";
import { deployReceiver } from "../../actions/oracle-receiver/deploy";

const step: MigrationStep = {
  name: "002-deploy-receiver",
  description: "Deploy OracleReceiver on Hydration EVM (Ethereum oracle source)",
  action: async (ctx) => {
    const wormholeCore = ctx.env.WORMHOLE_CORE_HYDRATION;
    if (!wormholeCore) throw new Error("Missing WORMHOLE_CORE_HYDRATION");

    return await deployReceiver({
      ...ctx.wallet.hydration,
      wormholeCore: wormholeCore as `0x${string}`,
    });
  },
};

export default step;
