import type { MigrationStep } from "./types";
import { deployImpl } from "../../actions/intent-dispatcher/upgrade";

const step: MigrationStep = {
  name: "003-deploy-impl",
  description: "Deploy the IntentDispatcher implementation with close",
  action: async (ctx) => {
    const proxy = ctx.env.HYDRATION_DISPATCHER as `0x${string}` | undefined;
    if (!proxy || /^0x0+$/.test(proxy)) throw new Error("HYDRATION_DISPATCHER is unset or zero");
    return await deployImpl({ ...ctx.wallet.hydration, proxy });
  },
};

export default step;
