import type { MigrationStep } from "../../types";
import { deployInstaBridge } from "../../actions/instaBridge/deploy";

const step: MigrationStep = {
  name: "deploy-bridge",
  description: "Deploy InstaBridge UUPS proxy",
  action: async (ctx) => {
    const env = ctx.env;
    const required = (key: string) => {
      if (!env[key]) throw new Error(`Missing ${key}`);
      return env[key];
    };

    return await deployInstaBridge({
      ...ctx.wallet,
      wormholeId: Number(required("WORMHOLE_ID")),
      wormholeCore: required("WORMHOLE_CORE") as `0x${string}`,
      tokenBridge: required("TOKEN_BRIDGE") as `0x${string}`,
    });
  },
};

export default step;
