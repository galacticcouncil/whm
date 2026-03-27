import type { MigrationStep } from "../../types";
import { deployInstaBridgeProxy } from "../../actions/instaBridge/deployProxy";

const step: MigrationStep = {
  name: "deploy-bridge-proxy",
  description: "Deploy InstaBridgeProxy UUPS proxy",
  action: async (ctx) => {
    const env = ctx.env;
    const required = (key: string) => {
      if (!env[key]) throw new Error(`Missing ${key}`);
      return env[key];
    };

    return await deployInstaBridgeProxy({
      ...ctx.wallet,
      wormholeCore: required("WORMHOLE_CORE") as `0x${string}`,
      tokenBridge: required("TOKEN_BRIDGE") as `0x${string}`,
    });
  },
};

export default step;
