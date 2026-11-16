import { pad } from "viem";

import type { MigrationStep } from "./types";
import { setEmitter } from "../../actions/psm/setEmitter";

const step: MigrationStep = {
  name: "005-set-base-emitter@facilitator",
  description: "Bind the Base vault as the facilitator's only authorized emitter (one-shot)",
  action: async (ctx) => {
    const facilitator = ctx.outputs["004-deploy-facilitator"].proxyAddress;
    const vault = ctx.outputs["001-deploy-vault"].proxyAddress;

    return await setEmitter({
      ...ctx.wallet.hydration,
      contract: facilitator as `0x${string}`,
      functionName: "setBaseEmitter",
      emitter: pad(vault as `0x${string}`, { size: 32 }),
    });
  },
};

export default step;
