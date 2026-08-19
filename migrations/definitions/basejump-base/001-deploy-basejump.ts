import type { MigrationStep } from "./types";
import { deploy } from "../../actions/basejump/deploy";

const step: MigrationStep = {
  name: "001-deploy-basejump",
  description: "Deploy Basejump UUPS proxy on Base",
  action: async (ctx) => {
    const required = (k: string) => {
      if (!ctx.env[k]) throw new Error(`Missing ${k}`);
      return ctx.env[k] as string;
    };

    // TokenBridge is unused on the NTT settlement path; kept in BasejumpCore
    // storage because BasejumpProxy still relies on it.
    return await deploy({
      ...ctx.wallet.base,
      wormholeId: Number(required("WORMHOLE_ID_BASE")),
      wormholeCore: required("WORMHOLE_CORE_BASE") as `0x${string}`,
      tokenBridge: "0x0000000000000000000000000000000000000000",
    });
  },
};

export default step;
