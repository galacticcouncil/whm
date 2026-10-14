import type { MigrationStep } from "./types";
import { deploy } from "../../actions/oracle-emitter-ethereum/deploy";

const step: MigrationStep = {
  name: "001-deploy-emitter",
  description: "Deploy OracleEmitter on Hydration EVM",
  action: async (ctx) => {
    const wormholeCore = ctx.env.WORMHOLE_CORE_HYDRATION;
    if (!wormholeCore) throw new Error("Missing WORMHOLE_CORE_HYDRATION");

    return await deploy({
      ...ctx.wallet.hydration,
      wormholeCore: wormholeCore as `0x${string}`,
    });
  },
};

export default step;
