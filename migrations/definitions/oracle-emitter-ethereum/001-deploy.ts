import type { MigrationStep } from "../../evm";
import { deploy } from "../../actions/oracle-emitter-ethereum/deploy";

const step: MigrationStep = {
  name: "deploy",
  description: "Deploy OracleEmitter implementation + UUPS proxy",
  action: async (ctx) => {
    const wormholeCore = ctx.env.WORMHOLE_CORE;
    if (!wormholeCore) throw new Error("Missing WORMHOLE_CORE");

    return await deploy({
      ...ctx.wallet,
      wormholeCore: wormholeCore as `0x${string}`,
    });
  },
};

export default step;
