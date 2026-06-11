import type { MigrationStep } from "./types";
import { deploy } from "../../actions/basejump/deploy";

const step: MigrationStep = {
  name: "002-deploy-basejump",
  description: "Deploy Basejump UUPS proxy on Ethereum",
  action: async (ctx) => {
    const required = (k: string) => {
      if (!ctx.env[k]) throw new Error(`Missing ${k}`);
      return ctx.env[k] as string;
    };

    return await deploy({
      ...ctx.wallet.ethereum,
      wormholeId: Number(required("WORMHOLE_ID_ETHEREUM")),
      wormholeCore: required("WORMHOLE_CORE_ETHEREUM") as `0x${string}`,
      tokenBridge: required("TOKEN_BRIDGE_ETHEREUM") as `0x${string}`,
    });
  },
};

export default step;
