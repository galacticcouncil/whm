import type { MigrationStep } from "./types";
import { deploy } from "../../actions/oracle-emitter-ethereum/deploy";

const step: MigrationStep = {
  name: "001-deploy-emitter",
  description: "Deploy OracleEmitter on Ethereum",
  action: async (ctx) => {
    const wormholeCore = ctx.env.WORMHOLE_CORE_ETHEREUM;
    if (!wormholeCore) throw new Error("Missing WORMHOLE_CORE_ETHEREUM");

    return await deploy({
      ...ctx.wallet.ethereum,
      wormholeCore: wormholeCore as `0x${string}`,
    });
  },
};

export default step;
