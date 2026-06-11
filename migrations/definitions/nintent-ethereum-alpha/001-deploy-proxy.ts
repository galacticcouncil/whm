import type { MigrationStep } from "./types";
import { deployProxy } from "../../actions/basejump/deployProxy";

const step: MigrationStep = {
  name: "001-deploy-proxy",
  description: "Deploy BasejumpProxy UUPS proxy on Moonbeam",
  action: async (ctx) => {
    const required = (k: string) => {
      if (!ctx.env[k]) throw new Error(`Missing ${k}`);
      return ctx.env[k] as string;
    };

    return await deployProxy({
      ...ctx.wallet.moonbeam,
      wormholeCore: required("WORMHOLE_CORE_MOONBEAM") as `0x${string}`,
      tokenBridge: required("TOKEN_BRIDGE_MOONBEAM") as `0x${string}`,
    });
  },
};

export default step;
