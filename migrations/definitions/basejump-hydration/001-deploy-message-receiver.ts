import type { MigrationStep } from "./types";
import { deploy } from "../../actions/basejump-message-receiver/deploy";

const step: MigrationStep = {
  name: "001-deploy-message-receiver",
  description: "Deploy BasejumpMessageReceiver UUPS proxy on Hydration",
  action: async (ctx) => {
    const required = (k: string) => {
      if (!ctx.env[k]) throw new Error(`Missing ${k}`);
      return ctx.env[k] as string;
    };

    return await deploy({
      ...ctx.wallet.hydration,
      wormholeId: Number(required("WORMHOLE_ID_HYDRATION")),
      wormholeCore: required("WORMHOLE_CORE_HYDRATION") as `0x${string}`,
    });
  },
};

export default step;
