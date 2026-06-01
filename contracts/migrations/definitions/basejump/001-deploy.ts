import type { MigrationStep } from "../../types";
import { deploy } from "../../actions/basejump/deploy";

const step: MigrationStep = {
  name: "deploy",
  description: "Deploy Basejump UUPS proxy",
  action: async (ctx) => {
    const env = ctx.env;
    const required = (key: string) => {
      if (!env[key]) throw new Error(`Missing ${key}`);
      return env[key];
    };

    return await deploy({
      ...ctx.wallet,
      wormholeId: Number(required("WORMHOLE_ID")),
      wormholeCore: required("WORMHOLE_CORE") as `0x${string}`,
      tokenBridge: required("TOKEN_BRIDGE") as `0x${string}`,
    });
  },
};

export default step;
